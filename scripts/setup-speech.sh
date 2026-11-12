#!/usr/bin/env bash
# Installs local speech recognition (faster-whisper) into stt/.venv and
# downloads the model once (small.en, about 480 MB), so the first walk is not slow.
set -euo pipefail
cd "$(dirname "$0")/.."
MODEL="${1:-small.en}"
if command -v uv >/dev/null; then
  uv venv -q stt/.venv --python 3.12 2>/dev/null || uv venv -q stt/.venv
  uv pip install -q --python stt/.venv/bin/python faster-whisper
else
  python3 -m venv stt/.venv
  stt/.venv/bin/pip install -q faster-whisper
fi
stt/.venv/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('$MODEL', device='cpu', compute_type='int8'); print('Speech model ready: $MODEL')"
