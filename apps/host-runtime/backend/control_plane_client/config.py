"""Control Plane client configuration.

All values default to empty/None — when CONTROL_PLANE_URL is not set,
the entire CP integration is disabled.
"""

from __future__ import annotations

import os

# URL of the Control Plane service (e.g., "https://cp.tryvoice.dev")
CONTROL_PLANE_URL: str = os.getenv("VS_CONTROL_PLANE_URL", "").rstrip("/")

# JWT token for authenticating this Host Runtime with the Control Plane.
# Obtained by the user from the CP dashboard or CLI.
CONTROL_PLANE_HOST_TOKEN: str = os.getenv("VS_CONTROL_PLANE_HOST_TOKEN", "")

# Human-readable name for this Host instance
CONTROL_PLANE_HOST_NAME: str = os.getenv("VS_CONTROL_PLANE_HOST_NAME", "TryVoice Host")

# Public URL where this Host Runtime is reachable (for direct client connections)
CONTROL_PLANE_HOST_PUBLIC_URL: str = os.getenv("VS_CONTROL_PLANE_HOST_PUBLIC_URL", "")

# Heartbeat interval in seconds
CONTROL_PLANE_HEARTBEAT_INTERVAL: int = int(os.getenv("VS_CONTROL_PLANE_HEARTBEAT_INTERVAL", "60"))


def is_cp_enabled() -> bool:
    """Return True if Control Plane integration is configured."""
    return bool(CONTROL_PLANE_URL and CONTROL_PLANE_HOST_TOKEN)
