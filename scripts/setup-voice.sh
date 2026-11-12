#!/usr/bin/env bash
# Installs the First Mate's voice (Kokoro, about 340 MB of models) into
# tts/.venv and tts/voices. Runs on the CPU; no GPU needed.
set -euo pipefail
cd "$(dirname "$0")/../tts"
if command -v uv >/dev/null; then
  uv venv -q .venv --python 3.12 2>/dev/null || uv venv -q .venv
  uv pip install -q --python .venv/bin/python kokoro-onnx soundfile
else
  python3 -m venv .venv
  .venv/bin/pip install -q kokoro-onnx soundfile
fi
mkdir -p voices
base=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
for f in kokoro-v1.0.onnx voices-v1.0.bin; do
  [ -s "voices/$f" ] || curl -fL --progress-bar -o "voices/$f" "$base/$f"
done
.venv/bin/python -c "from kokoro_onnx import Kokoro; Kokoro('voices/kokoro-v1.0.onnx', 'voices/voices-v1.0.bin'); print('Pirate voice ready.')"
