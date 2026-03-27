"""
Centralized path management for TryVoice.

PACKAGE_DIR  -- read-only assets bundled with the package (HTML, JS, CSS, models)
USER_DATA_DIR -- writable user config, database, logs  (~/.tryvoice/)
ENV_PATH -- project root .env

Path override env vars:
- TRYVOICE_USER_DATA_DIR (legacy: TRYCLAW_USER_DATA_DIR)
- TRYVOICE_SLOTS_PATH (legacy: OPENCLAW_SLOTS_PATH)
"""

import os
from pathlib import Path


def _resolve_user_data_dir() -> Path:
    override = os.getenv("TRYVOICE_USER_DATA_DIR", "").strip() or os.getenv("TRYCLAW_USER_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    _new_dir = Path.home() / ".tryvoice"
    _old_dir = Path.home() / ".tryclaw-chat"
    return _new_dir if _new_dir.exists() else (_old_dir if _old_dir.exists() else _new_dir)


def _resolve_slots_path(user_data_dir: Path) -> Path:
    override = os.getenv("TRYVOICE_SLOTS_PATH", "") or os.getenv("OPENCLAW_SLOTS_PATH", "")
    override = override.strip()
    if override:
        return Path(override).expanduser().resolve()
    return user_data_dir / "slots.json"


# ---- Package assets (read-only, installed with pip) ----
PACKAGE_DIR = Path(__file__).parent
PROJECT_ROOT = PACKAGE_DIR.parent.parent.parent  # repo root (apps/host-runtime/backend → root)
# Prefer static-dist/ (Docker build output) over static/ (dev/legacy)
_STATIC_DIST_DIR = PACKAGE_DIR / "static-dist"
INDEX_PATH = (
    (_STATIC_DIST_DIR / "index.html") if (_STATIC_DIST_DIR / "index.html").exists() else (PACKAGE_DIR / "index.html")
)
STATIC_DIR = (_STATIC_DIST_DIR / "static") if (_STATIC_DIST_DIR / "static").is_dir() else (PACKAGE_DIR / "static")
WAKEWORD_DIR = PACKAGE_DIR / "wakeword"
AVATARS_DIR = PACKAGE_DIR / "avatars"
DEFAULT_SETTINGS_PATH = PACKAGE_DIR / "default_settings.json"
ENV_EXAMPLE_PATH = PACKAGE_DIR / "env.example"

# ---- User data (writable, per-user) ----
USER_DATA_DIR = _resolve_user_data_dir()
PERSONALIZED_DIR = USER_DATA_DIR / "personalized"
ENV_PATH = PROJECT_ROOT / ".env"
SETTINGS_PATH = USER_DATA_DIR / "shared_settings.json"
SLOTS_PATH = _resolve_slots_path(USER_DATA_DIR)
DB_PATH = USER_DATA_DIR / "canonical_history.db"
LOG_DIR = USER_DATA_DIR / "logs"
LOG_FILE = LOG_DIR / "server.log"
CERT_PATH = USER_DATA_DIR / "cert.pem"
KEY_PATH = USER_DATA_DIR / "key.pem"
