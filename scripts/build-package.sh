#!/usr/bin/env bash
# Build the TryVoice Python package (wheel + sdist) with frontend included.
#
# Usage:
#   bash scripts/build-package.sh
#
# What it does:
#   1. Builds the frontend (npm ci + npm run build)
#   2. Copies frontend dist into backend/static-dist/
#   3. Runs python -m build to create wheel and sdist
#
# Prerequisites:
#   - Node.js 20+
#   - Python 3.9+ with 'build' package (pip install build)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$REPO_ROOT/apps/client-web/frontend"
BACKEND_STATIC="$REPO_ROOT/apps/host-runtime/backend/static-dist"

# ── 1. Build frontend ────────────────────────────────────────────────────────

if ! command -v node &>/dev/null; then
    echo "ERROR: Node.js not found. Install Node.js 20+ first."
    exit 1
fi

echo "Building frontend ..."
cd "$FRONTEND_DIR"
npm ci --silent
npm run build
cd "$REPO_ROOT"

# ── 2. Copy frontend dist into Python package ────────────────────────────────

echo "Copying frontend build to static-dist ..."
rm -rf "$BACKEND_STATIC"
mkdir -p "$BACKEND_STATIC"
cp -r "$FRONTEND_DIR/dist/." "$BACKEND_STATIC/"

# ── 3. Build Python package ──────────────────────────────────────────────────

echo "Building Python package ..."
rm -rf dist/ build/
find . -name "*.egg-info" -type d -exec rm -rf {} + 2>/dev/null || true
python -m build

echo ""
echo "Done."
ls -lh dist/tryvoice-*.whl dist/tryvoice-*.tar.gz
