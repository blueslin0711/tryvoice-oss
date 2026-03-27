"""Shared entry_points discovery utility.

Provides a single ``get_entry_points(group)`` helper that works across
Python 3.9 – 3.12+ and is used by the adapter, STT, and TTS registries.
"""

from __future__ import annotations

import sys
from importlib.metadata import entry_points


def get_entry_points(group: str):
    """Return entry points for *group*, compatible with Python 3.9+."""
    if sys.version_info >= (3, 12):
        return entry_points(group=group)
    # Python 3.9-3.11: entry_points() returns a dict or SelectableGroups
    eps = entry_points()
    if isinstance(eps, dict):
        return eps.get(group, [])
    # Python 3.10-3.11 may have .select()
    return eps.select(group=group) if hasattr(eps, "select") else []
