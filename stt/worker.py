#!/usr/bin/env python3
"""Speech-to-text worker for the firstmate dispatcher.

The phone streams raw microphone audio; this process cuts it into utterances
at pauses and transcribes each one with Whisper, running locally on this
machine. Nothing leaves the computer.

stdin carries framed messages: one kind byte, a 4-byte big-endian length,
then the payload.
    A  audio: PCM 16-bit little-endian, mono, 16 kHz
    H  hints: UTF-8 JSON {"prompt": "..."} words to prime recognition with
    F  flush: the phone stopped listening; finish any utterance now
    R  reset: drop buffered audio without transcribing it

stdout carries one JSON object per line:
    {"type": "ready", "model": "small.en"}
    {"type": "speech", "on": true}         someone started / stopped talking
    {"type": "final", "text": "...", "ms": 412}
    {"type": "log", "message": "..."}
"""
import json
import os
import struct
import sys
import threading
import time
import queue

import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.vad import VadOptions, get_speech_timestamps

RATE = 16000
MODEL = os.environ.get("FIRSTMATE_STT_MODEL", "small.en")
THREADS = int(os.environ.get("FIRSTMATE_STT_THREADS", "8"))

END_SILENCE = 0.7      # seconds of quiet (after VAD padding) that ends an utterance; set by "P"
CHECK_EVERY = 0.25     # seconds of new audio between VAD passes
MAX_UTTERANCE = 25.0   # force a cut on very long monologues
PREROLL = 0.5          # audio kept from before speech starts
PAD = 0.2

VAD = VadOptions(threshold=0.6, min_speech_duration_ms=250, min_silence_duration_ms=450, speech_pad_ms=200)

# Near-field gate: the wearer's voice reaches an earbud mic far louder than
# people nearby or the dispatcher's own voice leaking back. Utterances much
# quieter than the wearer's usual level are ignored.
FLOOR_DBFS = -52.0      # never accept anything quieter than this
BELOW_WEARER_DB = 13.0  # ignore speech this far below the wearer's recent level

# Whisper's well-known inventions on breath, wind and silence.
PHANTOMS = {
    "", "you", "thank you", "thanks", "thank you very much", "thanks for watching", "thank you for watching",
    "bye", "bye bye", "okay", "oh", "uh", "um", "hmm", "mm", "so", "the", "i", "a",
}


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def clean(text):
    return " ".join(text.replace("\n", " ").split()).strip()


class Listener:
    def __init__(self, model):
        self.model = model
        self.buf = np.zeros(0, dtype=np.float32)
        self.unchecked = 0
        self.speaking = False
        self.prompt = None
        self.levels = []  # loudness of recent accepted utterances, dBFS
        self.jobs = queue.Queue()
        threading.Thread(target=self._transcriber, daemon=True).start()

    # ---- audio in ----
    def audio(self, payload):
        samples = np.frombuffer(payload, dtype="<i2").astype(np.float32) / 32768.0
        self.buf = np.concatenate([self.buf, samples])
        self.unchecked += len(samples)
        if self.unchecked >= CHECK_EVERY * RATE:
            self.unchecked = 0
            self._check()

    def flush(self):
        self._check(final=True)

    def reset(self):
        self.buf = np.zeros(0, dtype=np.float32)
        self._set_speaking(False)

    # ---- segmentation ----
    def _set_speaking(self, on):
        if on != self.speaking:
            self.speaking = on
            emit({"type": "speech", "on": on})

    def _check(self, final=False):
        if len(self.buf) < RATE * 0.3:
            if final:
                self.reset()
            return
        stamps = get_speech_timestamps(self.buf, VAD, sampling_rate=RATE)
        if not stamps:
            self._set_speaking(False)
            keep = int(PREROLL * RATE)
            self.buf = self.buf[-keep:]
            return
        self._set_speaking(True)
        start, end = stamps[0]["start"], stamps[-1]["end"]
        quiet = (len(self.buf) - end) / RATE
        too_long = (end - start) / RATE >= MAX_UTTERANCE
        if final or quiet >= END_SILENCE or too_long:
            a = max(0, start - int(PAD * RATE))
            b = min(len(self.buf), end + int(PAD * RATE))
            self.jobs.put(self.buf[a:b].copy())
            self.buf = self.buf[b:]
            self._set_speaking(False)

    # ---- recognition ----
    def _loud_enough(self, clip):
        # Loudness of the speech itself: the top quarter of 30 ms frames.
        n = len(clip) // 480 * 480
        if n == 0:
            return False, -99.0
        frames = clip[:n].reshape(-1, 480)
        rms = np.sqrt((frames ** 2).mean(axis=1) + 1e-12)
        level = float(20 * np.log10(np.percentile(rms, 75) + 1e-9))
        if level < FLOOR_DBFS:
            return False, level
        if len(self.levels) >= 3:
            wearer = float(np.median(self.levels))
            if level < wearer - BELOW_WEARER_DB:
                return False, level
        return True, level

    def _transcriber(self):
        while True:
            clip = self.jobs.get()
            t0 = time.time()
            ok, level = self._loud_enough(clip)
            if not ok:
                emit({"type": "dropped", "why": f"distant or quiet speech ({level:.0f} dBFS)"})
                continue
            try:
                segments, _ = self.model.transcribe(
                    clip,
                    language="en",
                    beam_size=5,
                    # No retries at higher temperature: they multiply latency on short clips.
                    temperature=0.0,
                    vad_filter=False,
                    condition_on_previous_text=False,
                    without_timestamps=True,
                    initial_prompt=self.prompt,
                )
                parts = []
                for s in segments:
                    # Whisper unsure it heard words at all, or guessing wildly.
                    if s.no_speech_prob > 0.5 or s.avg_logprob < -0.9 or s.compression_ratio > 2.4:
                        continue
                    parts.append(s.text)
                text = clean(" ".join(parts))
            except Exception as e:  # keep listening whatever happens
                emit({"type": "log", "message": f"transcribe failed: {e}"})
                emit({"type": "dropped", "why": "error"})
                continue
            plain = "".join(ch for ch in text.lower() if ch.isalnum() or ch == " ").strip()
            if plain in PHANTOMS:
                emit({"type": "dropped", "why": "not words"})
                continue
            self.levels = (self.levels + [level])[-12:]
            emit({"type": "final", "text": text, "ms": int((time.time() - t0) * 1000), "secs": round(len(clip) / RATE, 2), "db": round(level)})


def read_exact(stream, n):
    data = b""
    while len(data) < n:
        chunk = stream.read(n - len(data))
        if not chunk:
            return None
        data += chunk
    return data


def main():
    model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=THREADS)
    listener = Listener(model)
    # Warm up so the first real utterance is not slow.
    list(model.transcribe(np.zeros(RATE, dtype=np.float32), language="en")[0])
    emit({"type": "ready", "model": MODEL})
    stdin = sys.stdin.buffer
    while True:
        head = read_exact(stdin, 5)
        if head is None:
            return
        kind, size = head[:1], struct.unpack(">I", head[1:])[0]
        payload = read_exact(stdin, size) if size else b""
        if payload is None:
            return
        if kind == b"A":
            listener.audio(payload)
        elif kind == b"H":
            try:
                listener.prompt = json.loads(payload.decode("utf-8")).get("prompt") or None
            except ValueError:
                pass
        elif kind == b"F":
            listener.flush()
        elif kind == b"R":
            listener.reset()
        elif kind == b"P":
            # Pause length that ends an utterance: longer while dictating, so a
            # breath between thoughts does not split the sentence.
            global END_SILENCE
            try:
                END_SILENCE = max(0.4, min(3.0, float(payload.decode("ascii"))))
            except ValueError:
                pass


if __name__ == "__main__":
    main()
