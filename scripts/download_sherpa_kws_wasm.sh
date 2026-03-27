#!/usr/bin/env bash
# Download sherpa-onnx browser KWS WASM files.
# Uses the browser bundle (NOT the nodejs tarball).
set -e

VERSION="${1:-1.12.28}"
URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/v${VERSION}/sherpa-onnx-wasm-kws-v${VERSION}.tar.bz2"
DEST="$(cd "$(dirname "$0")/.." && pwd)/apps/host-runtime/backend/static-dist/static"

echo "Downloading sherpa-onnx KWS WASM v${VERSION}..."
TMP=$(mktemp -d)
curl -L "$URL" | tar -xj -C "$TMP"

# Find and copy the two required files (JS + WASM must be co-located)
JS=$(find "$TMP" -name "sherpa-onnx-wasm-kws-main.js" | head -1)
WASM=$(find "$TMP" -name "sherpa-onnx-wasm-kws-main.wasm" | head -1)

if [ -z "$JS" ] || [ -z "$WASM" ]; then
  echo "ERROR: expected files not found in archive. Contents:"
  find "$TMP" -type f
  rm -rf "$TMP"
  exit 1
fi

cp "$JS" "$DEST/sherpa-onnx-wasm-kws-main.js"
cp "$WASM" "$DEST/sherpa-onnx-wasm-kws-main.wasm"
rm -rf "$TMP"

echo "Done. Files written to $DEST/"
ls -lh "$DEST/sherpa-onnx-wasm-kws-main."*
