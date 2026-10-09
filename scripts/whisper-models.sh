#!/usr/bin/env bash
# Shared Whisper model table for setup-whisper.sh and build-whisper-portable.sh.
# Every file is an official ggml conversion from huggingface.co/ggerganov/whisper.cpp,
# pinned by size and SHA-256 (the Hugging Face LFS object id). Keep the names in sync with
# WHISPER_MODELS in apps/api/src/modules/integrity/whisper.ts.
#
#   name                  file                          approx size  note
#   small.en              ggml-small.en-q5_1.bin        190 MB       default: keeps up live on an Intel Mac CPU
#   large-v3-turbo        ggml-large-v3-turbo-q5_0.bin  574 MB       most accurate per second; Apple Silicon / fast CPUs
#   large-v3              ggml-large-v3-q5_0.bin        1.08 GB      heaviest; fast Apple Silicon Macs only
#   base                  ggml-base-q5_1.bin            60 MB        low-end laptops (least accurate, old default)

WHISPER_DEFAULT_MODEL="small.en"
WHISPER_MODEL_BASE_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

# Prints "<file> <bytes> <sha256>" for a model name, or fails for an unknown name.
whisper_model_info() {
  case "$1" in
    large-v3-turbo) echo "ggml-large-v3-turbo-q5_0.bin 574041195 394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2" ;;
    small.en) echo "ggml-small.en-q5_1.bin 190098681 bfdff4894dcb76bbf647d56263ea2a96645423f1669176f4844a1bf8e478ad30" ;;
    large-v3) echo "ggml-large-v3-q5_0.bin 1081140203 d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1" ;;
    base) echo "ggml-base-q5_1.bin 59707625 422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898" ;;
    *)
      echo "Unknown WHISPER_MODEL '$1' (use large-v3-turbo, small.en, large-v3 or base)." >&2
      return 1
      ;;
  esac
}

# whisper_fetch_model <name> <dest-dir>: download into dest-dir unless a verified copy exists.
whisper_fetch_model() {
  local info file size sha dest actual
  info="$(whisper_model_info "$1")" || return 1
  read -r file size sha <<<"$info"
  dest="$2/$file"
  mkdir -p "$2"
  if [ -f "$dest" ] && [ "$(wc -c <"$dest" | tr -d ' ')" = "$size" ]; then
    echo "model present: $dest"
    return 0
  fi
  echo "downloading $file ($((size / 1000000)) MB)..."
  curl -fL --retry 3 --progress-bar -o "$dest.part" "$WHISPER_MODEL_BASE_URL/$file"
  actual="$(shasum -a 256 "$dest.part" 2>/dev/null || sha256sum "$dest.part")"
  actual="${actual%% *}"
  if [ "$actual" != "$sha" ] || [ "$(wc -c <"$dest.part" | tr -d ' ')" != "$size" ]; then
    rm -f "$dest.part"
    echo "checksum mismatch for $file (expected $sha, got $actual)" >&2
    return 1
  fi
  mv "$dest.part" "$dest"
  echo "model verified: $dest"
}
