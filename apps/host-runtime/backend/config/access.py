"""Access control configuration — passwords, cookies, key exposure."""

import os

# ---- Access control ----
ACCESS_PASSWORD = os.getenv("TRYVOICE_ACCESS_PASSWORD", "").strip() or os.getenv("TRYCLAW_ACCESS_PASSWORD", "").strip()
ACCESS_COOKIE_NAME = (
    os.getenv("TRYVOICE_ACCESS_COOKIE_NAME", "").strip()
    or os.getenv("TRYCLAW_ACCESS_COOKIE_NAME", "tryvoice_access").strip()
    or "tryvoice_access"
)
ACCESS_SESSION_SECRET = (
    os.getenv("TRYVOICE_ACCESS_SESSION_SECRET", "").strip() or os.getenv("TRYCLAW_ACCESS_SESSION_SECRET", "").strip()
)
ACCESS_SESSION_TTL_SECONDS = int(
    os.getenv("TRYVOICE_ACCESS_SESSION_TTL_SECONDS", "") or os.getenv("TRYCLAW_ACCESS_SESSION_TTL_SECONDS", "604800")
)


# ---- Sensitive key exposure guards ----
def _bool_env(*names: str, default: bool = False) -> bool:
    for name in names:
        val = os.getenv(name, "").strip().lower()
        if val in {"1", "true", "yes", "on"}:
            return True
        if val in {"0", "false", "no", "off"}:
            return False
    return default


EXPOSE_BROWSER_STT_KEY = _bool_env("TRYVOICE_EXPOSE_BROWSER_STT_KEY", "TRYCLAW_EXPOSE_BROWSER_STT_KEY", default=True)
EXPOSE_PICOVOICE_KEY = _bool_env("TRYVOICE_EXPOSE_PICOVOICE_KEY", "TRYCLAW_EXPOSE_PICOVOICE_KEY")
