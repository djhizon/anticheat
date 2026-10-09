#!/usr/bin/env bash
# Create the Python environment for the optional server-side OWL-ViT check
# (ENABLE_BACKEND_VISION=true). Output lands in apps/api/vendor/venv (gitignored).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/apps/api/vendor/venv"
PYTHON="${PYTHON:-python3}"

"$PYTHON" -m venv "$VENV"
"$VENV/bin/pip" install --upgrade pip
if [ "$(uname -s)-$(uname -m)" = "Darwin-x86_64" ]; then
  # PyTorch stopped publishing Intel-Mac wheels at 2.2.2 (Python <= 3.12),
  # so pin a compatible stack. Run with PYTHON=python3.12 on these machines.
  "$VENV/bin/pip" install "torch==2.2.2" "transformers<4.46" "numpy<2" Pillow
else
  "$VENV/bin/pip" install transformers Pillow torch
fi
echo "vision python: $VENV/bin/python"
