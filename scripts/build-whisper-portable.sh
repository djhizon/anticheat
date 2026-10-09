#!/usr/bin/env bash
# Build a portable (static, no native-CPU flags, no Metal) whisper-cli for the packaged
# desktop app. Output: apps/desktop/native-bin/whisper/{whisper-cli,ggml-base-q5_1.bin}.
# The model is the 5-bit quantized multilingual base (about 57 MB vs 148 MB, same jfk.wav transcript).
# Builds x86_64 only (the dmg is x64); set WHISPER_UNIVERSAL=1 to also build arm64 and lipo them.
# Skips everything if the output already exists (pass --force to rebuild).
set -euo pipefail

WHISPER_TAG="${WHISPER_TAG:-v1.9.5}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/apps/api/vendor/whisper.cpp-portable"
OUT="$ROOT/apps/desktop/native-bin/whisper"
TARGET="13.0"
MODEL="ggml-base-q5_1.bin"

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
    -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_METAL=OFF -DGGML_BLAS=OFF \
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

rm -f "$OUT/ggml-base.bin" # drop the old full-size model if a previous build left it behind
if [ ! -f "$OUT/$MODEL" ]; then
  bash "$SRC/models/download-ggml-model.sh" base-q5_1
  mv "$SRC/models/$MODEL" "$OUT/$MODEL"
fi
echo "whisper-cli: $OUT/whisper-cli ($(lipo -archs "$OUT/whisper-cli"))"
echo "model:       $OUT/$MODEL"
otool -L "$OUT/whisper-cli"
