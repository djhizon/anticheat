#!/usr/bin/env bash
# Build whisper.cpp (upstream, pinned) and download the base model for local
# speech transcription. Output lands in apps/api/vendor/whisper.cpp (gitignored).
set -euo pipefail

WHISPER_TAG="${WHISPER_TAG:-v1.9.5}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/apps/api/vendor/whisper.cpp"

if [ ! -d "$DEST/.git" ]; then
  git clone --depth 1 --branch "$WHISPER_TAG" https://github.com/ggml-org/whisper.cpp.git "$DEST"
fi
cmake -S "$DEST" -B "$DEST/build" -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF
cmake --build "$DEST/build" --config Release -j --target whisper-cli
if [ ! -f "$DEST/models/ggml-base.bin" ]; then
  bash "$DEST/models/download-ggml-model.sh" base
fi
echo "whisper-cli: $DEST/build/bin/whisper-cli"
echo "model:       $DEST/models/ggml-base.bin"
