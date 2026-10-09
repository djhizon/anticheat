#!/usr/bin/env bash
# Build whisper.cpp (upstream, pinned) and download the speech model for local
# transcription. Output lands in apps/api/vendor/whisper.cpp (gitignored).
# Model: WHISPER_MODEL (default small.en; base for low-end laptops; large-v3-turbo or
# large-v3 for fast Apple Silicon Macs). See scripts/whisper-models.sh.
set -euo pipefail

WHISPER_TAG="${WHISPER_TAG:-v1.9.5}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/apps/api/vendor/whisper.cpp"
# shellcheck source=scripts/whisper-models.sh
source "$ROOT/scripts/whisper-models.sh"
MODEL_NAME="${WHISPER_MODEL:-$WHISPER_DEFAULT_MODEL}"
whisper_model_info "$MODEL_NAME" >/dev/null

if [ ! -d "$DEST/.git" ]; then
  git clone --depth 1 --branch "$WHISPER_TAG" https://github.com/ggml-org/whisper.cpp.git "$DEST"
fi
cmake -S "$DEST" -B "$DEST/build" -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF
cmake --build "$DEST/build" --config Release -j --target whisper-cli
whisper_fetch_model "$MODEL_NAME" "$DEST/models"
read -r MODEL_FILE _ <<<"$(whisper_model_info "$MODEL_NAME")"
echo "whisper-cli: $DEST/build/bin/whisper-cli"
echo "model:       $DEST/models/$MODEL_FILE"
