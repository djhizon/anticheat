#!/usr/bin/env bash
# Build a portable (static, no native-CPU flags, no Metal) whisper-cli for the packaged
# desktop app. Output: apps/desktop/native-bin/whisper/{whisper-cli,<model>.bin}.
# The model is WHISPER_MODEL (default small.en, 5-bit quantized, about 190 MB; use
# WHISPER_MODEL=base for a smaller dmg, large-v3-turbo for a more accurate one). Downloads are verified against scripts/whisper-models.sh.
# Matrix multiplication uses Apple Accelerate (a system framework, so still portable):
# without it the encoder is several times slower on Intel CPUs.
# Builds x86_64 only (the dmg is x64); set WHISPER_UNIVERSAL=1 to also build arm64 and lipo them.
# Skips everything if the output already exists (pass --force to rebuild).
set -euo pipefail

WHISPER_TAG="${WHISPER_TAG:-v1.9.5}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/apps/api/vendor/whisper.cpp-portable"
OUT="$ROOT/apps/desktop/native-bin/whisper"
TARGET="13.0"
# shellcheck source=scripts/whisper-models.sh
source "$ROOT/scripts/whisper-models.sh"
MODEL_NAME="${WHISPER_MODEL:-$WHISPER_DEFAULT_MODEL}"
whisper_model_info "$MODEL_NAME" >/dev/null
read -r MODEL _ <<<"$(whisper_model_info "$MODEL_NAME")"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-whisper-portable.sh targets macOS only; skipping." >&2
  exit 0
fi
if [ "${1:-}" != "--force" ] && [ -x "$OUT/whisper-cli" ] && [ -f "$OUT/$MODEL" ]; then
  echo "whisper-cli already built: $OUT (use --force to rebuild)"
  exit 0
fi

mkdir -p "$OUT"
if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 --branch "$WHISPER_TAG" https://github.com/ggml-org/whisper.cpp.git "$SRC"
fi

build_arch() {
  local arch="$1" dir="$SRC/build-$1"
  cmake -S "$SRC" -B "$dir" -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF \
    -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_METAL=OFF -DGGML_BLAS=ON \
    -DCMAKE_OSX_ARCHITECTURES="$arch" -DCMAKE_OSX_DEPLOYMENT_TARGET="$TARGET"
  cmake --build "$dir" --config Release -j --target whisper-cli
}

build_arch x86_64
BINS=("$SRC/build-x86_64/bin/whisper-cli")
if [ "${WHISPER_UNIVERSAL:-0}" != "1" ]; then
  :
elif build_arch arm64; then
  BINS+=("$SRC/build-arm64/bin/whisper-cli")
else
  echo "arm64 build failed; shipping x86_64 only." >&2
fi
if [ "${#BINS[@]}" -gt 1 ]; then
  lipo -create "${BINS[@]}" -output "$OUT/whisper-cli"
else
  cp "${BINS[0]}" "$OUT/whisper-cli"
fi
chmod +x "$OUT/whisper-cli"

# Ship exactly one model: drop any other ggml file a previous build left behind.
find "$OUT" -maxdepth 1 -name 'ggml-*.bin' ! -name "$MODEL" -delete
whisper_fetch_model "$MODEL_NAME" "$OUT"
echo "whisper-cli: $OUT/whisper-cli ($(lipo -archs "$OUT/whisper-cli"))"
echo "model:       $OUT/$MODEL"
otool -L "$OUT/whisper-cli"
