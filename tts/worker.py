#!/usr/bin/env python3
"""Voice worker for First Mate: turns the First Mate's lines into speech.

Runs locally on the computer. Each line is spoken a sentence at a time, so
the phone can start playing the first sentence while the rest is made.

stdin, one JSON object per line:
    {"id": 7, "text": "...", "gen": 3, "dense": false}   speak this
    {"cancel": 4}                                          drop everything before generation 4
stdout, one JSON object per line:
    {"type": "ready", "engine": "kokoro", "voice": "bm_george"}
    {"type": "chunk", "id": 7, "seq": 0, "last": false, "rate": 20640,
     "marks": [[char_offset, ms], ...], "pcm": "<base64 int16 mono>"}
    {"type": "log", "message": "..."}

Pirate sound: the voice is rendered faster than normal and played back slower
(`pitch` < 1), which lowers and roughens it while keeping the pace.
"""
import base64
import json
import os
import queue
import re
import sys
import threading

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.loads(os.environ.get("FIRSTMATE_VOICE", "{}"))
ENGINE = CFG.get("engine", "kokoro")
NAME = CFG.get("name", "bm_george")
LABEL = "+".join(CFG["blend"]) if CFG.get("blend") else NAME
PITCH = float(CFG.get("pitch", 0.86))      # playback rate factor: lower is deeper
SPEED = float(CFG.get("speed", 0.95))      # overall pace once pitched
DENSE = float(CFG.get("denseSpeed", 0.85))  # pace for lines with numbers and names
VOICES = os.path.join(HERE, "voices")


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


class KokoroVoice:
    def __init__(self):
        from kokoro_onnx import Kokoro
        self.k = Kokoro(os.path.join(VOICES, "kokoro-v1.0.onnx"), os.path.join(VOICES, "voices-v1.0.bin"))
        self.styles = {}

    def style(self, blend):
        """A voice pack: several voices mixed by weight into one. Cached."""
        key = json.dumps(blend, sort_keys=True)
        if key not in self.styles:
            if isinstance(blend, dict):
                total = sum(blend.values())
                self.styles[key] = sum(self.k.get_voice_style(v) * (w / total) for v, w in blend.items()).astype(np.float32)
            else:
                self.styles[key] = blend
        return self.styles[key]

    def say(self, text, pace, pitch, blend):
        first = max(blend, key=blend.get) if isinstance(blend, dict) else blend
        lang = CFG.get("accent") or ("en-gb" if first.startswith("b") else "en-us")
        audio, sr = self.k.create(text, voice=self.style(blend), speed=min(2.0, pace / pitch), lang=lang)
        return audio, sr


class PiperVoice:
    def __init__(self):
        from piper import PiperVoice as P, SynthesisConfig
        self.v = P.load(os.path.join(VOICES, f"{NAME}.onnx"))
        self.cfg = SynthesisConfig

    def say(self, text, pace, pitch, blend):
        chunks = list(self.v.synthesize(text, syn_config=self.cfg(length_scale=pitch / pace)))
        return np.concatenate([c.audio_float_array for c in chunks]), chunks[0].sample_rate


SENTENCE = re.compile(r"[^.!?]+(?:[.!?]+|$)")
WORD = re.compile(r"\S+")


def sentences(text):
    """(offset, sentence) pairs covering the text."""
    out = []
    for m in SENTENCE.finditer(text):
        s = m.group(0)
        lead = len(s) - len(s.lstrip())
        if s.strip():
            out.append((m.start() + lead, s.strip()))
    return out or [(0, text)]


def marks(offset, sentence, ms):
    """Estimated start time of each word, weighted by length and pauses."""
    words = [(m.start(), m.group(0)) for m in WORD.finditer(sentence)]
    if not words:
        return []
    weight = []
    for _, w in words:
        pause = 3 if w[-1] in ".!?:" else 1.5 if w[-1] in ",;" else 0
        weight.append(len(w.strip(".,!?;:")) + 1.5 + pause)
    total = sum(weight)
    lead = 80  # the engines start each sentence with a short breath of silence
    usable = max(1, ms - lead - 120)
    t = lead
    out = []
    for (pos, _), wgt in zip(words, weight):
        out.append([offset + pos, int(t)])
        t += usable * wgt / total
    return out


def deepen(audio, pitch):
    """Stretch the audio so that played at its own rate it sounds lower.

    Rendering fast and stretching gives the pirate growl at a normal pace, and
    keeps every line at one sample rate, so voices can change line by line.
    """
    if abs(pitch - 1.0) < 1e-3:
        return audio
    n = int(len(audio) / pitch)
    return np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)


DEFAULT_BLEND = CFG.get("blend") or NAME


def main():
    voice = KokoroVoice() if ENGINE == "kokoro" else PiperVoice()
    voice.say("Ahoy.", SPEED, PITCH, DEFAULT_BLEND)  # warm up
    emit({"type": "ready", "engine": ENGINE, "voice": LABEL})

    jobs = queue.Queue()
    state = {"gen": 0}

    def reader():
        for line in sys.stdin:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if "cancel" in msg:
                state["gen"] = max(state["gen"], int(msg["cancel"]))
            else:
                jobs.put(msg)
        os._exit(0)

    threading.Thread(target=reader, daemon=True).start()
    while True:
        job = jobs.get()
        if job.get("gen", 0) < state["gen"]:
            continue
        parts = sentences(job["text"])
        pace = DENSE if job.get("dense") else SPEED
        who = job.get("voice") or {}
        pitch = float(who.get("pitch", PITCH))
        blend = who.get("blend") or DEFAULT_BLEND
        pace *= float(who.get("speed", 1.0))
        for seq, (offset, sentence) in enumerate(parts):
            if job.get("gen", 0) < state["gen"]:
                break
            try:
                audio, sr = voice.say(sentence, pace, pitch, blend)
            except Exception as e:  # never stop talking because of one line
                emit({"type": "log", "message": f"voice failed: {e}"})
                continue
            audio = deepen(audio, pitch)
            rate = sr
            pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
            ms = len(audio) / rate * 1000
            emit({
                "type": "chunk", "id": job["id"], "seq": seq, "last": seq == len(parts) - 1,
                "rate": rate, "marks": marks(offset, sentence, ms),
                "pcm": base64.b64encode(pcm).decode("ascii"),
            })


if __name__ == "__main__":
    main()
