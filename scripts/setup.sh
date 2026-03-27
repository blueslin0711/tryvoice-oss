#!/usr/bin/env bash
# One-command setup for TryVoice development environment
#
# Usage:
#   bash scripts/setup.sh          # Full setup (venv + backend + frontend)
#   bash scripts/setup.sh --skip-frontend  # Backend only (no Node.js required)
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SKIP_FRONTEND=0
for arg in "$@"; do
    case "$arg" in
        --skip-frontend) SKIP_FRONTEND=1 ;;
    esac
done

# ── 1. Python virtual environment ──────────────────────────────────────────

VENV_DIR="$REPO_ROOT/.venv"
if [ ! -d "$VENV_DIR" ]; then
    echo "Creating Python virtual environment (.venv)..."
    python3 -m venv "$VENV_DIR"
fi

# Activate venv
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
echo "Using Python: $(python --version) at $(which python)"

# ── 2. Install Python packages ─────────────────────────────────────────────

echo ""
echo "Installing TryVoice Python packages..."
pip install -e ".[all,dev]"

# Install third-party plugin packages (editable, for development)
echo ""
echo "Installing plugins..."
for plugin_dir in "$REPO_ROOT"/adapters/*/ "$REPO_ROOT"/packages/*/; do
    if [ -d "$plugin_dir" ] && [ -f "$plugin_dir/pyproject.toml" ]; then
        echo "  Installing $(basename "$plugin_dir")..."
        pip install -e "$plugin_dir"
    fi
done

# ── 3. Build frontend ──────────────────────────────────────────────────────

FRONTEND_DIR="$REPO_ROOT/apps/client-web/frontend"

if [ "$SKIP_FRONTEND" -eq 0 ]; then
    if ! command -v node &>/dev/null; then
        echo ""
        echo "WARNING: Node.js not found. Skipping frontend build."
        echo "  Install Node.js 20+ and re-run, or run:"
        echo "    cd apps/client-web/frontend && npm install && npm run build"
    else
        echo ""
        echo "Building frontend (apps/client-web/frontend)..."
        cd "$FRONTEND_DIR"
        npm install
        npx vite build
        cd "$REPO_ROOT"

        # Copy build output to backend static-dist
        BACKEND_STATIC="$REPO_ROOT/apps/host-runtime/backend/static-dist"
        mkdir -p "$BACKEND_STATIC/static"
        cp -r "$FRONTEND_DIR/dist/static/"* "$BACKEND_STATIC/static/"
        cp "$FRONTEND_DIR/dist/index.html" "$BACKEND_STATIC/index.html"
        cp "$FRONTEND_DIR/dist/index.html" "$REPO_ROOT/apps/host-runtime/backend/index.html"

        # Download third-party assets to serve locally (avoid CDN failures on mobile / China networks).
        # These files are fetched from CDN at build time only; at runtime they are served from /static/.
        ORT_VERSION="1.14.0"
        ORT_CDN="https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist"
        for f in ort.js ort-wasm.wasm ort-wasm-simd.wasm; do
            if [ ! -f "$BACKEND_STATIC/static/$f" ]; then
                echo "  Downloading $f ..."
                curl -sL "$ORT_CDN/$f" -o "$BACKEND_STATIC/static/$f"
            fi
        done

        KATEX_VERSION="0.16.9"
        KATEX_CSS="https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min.css"
        if [ ! -f "$BACKEND_STATIC/static/katex.min.css" ]; then
            echo "  Downloading katex.min.css ..."
            curl -sL "$KATEX_CSS" -o "$BACKEND_STATIC/static/katex.min.css"
        fi

        SPEECH_SDK_VERSION="1.48.0"
        SPEECH_SDK_JS="https://cdn.jsdelivr.net/npm/microsoft-cognitiveservices-speech-sdk@${SPEECH_SDK_VERSION}/distrib/browser/microsoft.cognitiveservices.speech.sdk.bundle-min.js"
        if [ ! -f "$BACKEND_STATIC/static/microsoft.cognitiveservices.speech.sdk.bundle-min.js" ]; then
            echo "  Downloading microsoft.cognitiveservices.speech.sdk.bundle-min.js ..."
            curl -sL "$SPEECH_SDK_JS" -o "$BACKEND_STATIC/static/microsoft.cognitiveservices.speech.sdk.bundle-min.js"
        fi

        echo "Frontend built and local assets bundled."
    fi
else
    echo ""
    echo "Skipping frontend build (--skip-frontend)."
fi

# ── 4. Environment file ────────────────────────────────────────────────────

ENV_PATH="$REPO_ROOT/.env"
if [ ! -f "$ENV_PATH" ]; then
    cp "$REPO_ROOT/.env.example" "$ENV_PATH"
    echo ""
    echo "Created .env from .env.example — edit it to add your API keys."
else
    echo ""
    echo ".env already exists, skipping."
fi

# ── 5. Done ─────────────────────────────────────────────────────────────────

echo ""
echo "============================================"
echo "  Setup complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Activate the virtual environment:"
echo "       source .venv/bin/activate"
echo ""
echo "  2. Edit .env with your API keys (see .env.example for reference)"
echo ""
echo "  3. Start the server:"
echo "       python -m backend.cli"
echo ""
echo "  4. Open http://localhost:7860 in your browser"
echo ""
