#!/usr/bin/env bash
# Download sherpa-onnx KWS Zipformer GigaSpeech model and generate keywords.txt.
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL_NAME="sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
DEST="$REPO_ROOT/apps/host-runtime/backend/wakeword/sherpa-kws"
SCRIPTS="$REPO_ROOT/scripts"

echo "Downloading model $MODEL_NAME..."
mkdir -p "$DEST"
curl -L "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${MODEL_NAME}.tar.bz2" \
  | tar -xj --strip-components=1 -C "$DEST"

echo "Model files:"
ls -lh "$DEST/"

echo ""
echo "Generating keywords.txt..."
python "$SCRIPTS/generate_sherpa_kws_keywords.py" \
  --tokens "$DEST/tokens.txt" \
  --words "americano snowboy terminator bumblebee jarvis grasshopper transmit dispatch discontinue suspend" \
  --output "$DEST/keywords.txt"

echo ""
echo "keywords.txt:"
cat "$DEST/keywords.txt"
