"""SQLite-backed storage for adapter configurations and bot instances."""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any


class ConfigStore:
    """CRUD operations for adapter_configs and bot_instances tables."""

    def __init__(self, db_path: str):
        self._db_path = Path(db_path)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()
        self._conn = sqlite3.connect(str(self._db_path), check_same_thread=False, timeout=10)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock:
            self._conn.executescript("""
                CREATE TABLE IF NOT EXISTS adapter_configs (
                    id TEXT PRIMARY KEY,
                    adapter_type TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    config_json TEXT NOT NULL DEFAULT '{}',
                    is_active INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS bot_instances (
                    id TEXT PRIMARY KEY,
                    adapter_config_id TEXT NOT NULL
                        REFERENCES adapter_configs(id) ON DELETE CASCADE,
                    bot_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    session_key TEXT NOT NULL,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    is_active INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS bot_summaries (
                    bot_id TEXT PRIMARY KEY,
                    summary TEXT NOT NULL DEFAULT '',
                    generated_at TEXT NOT NULL DEFAULT ''
                );

                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL DEFAULT ''
                );
            """)

    def _now(self) -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # -- Adapter configs ---------------------------------------------------

    def save_adapter_config(
        self,
        adapter_type: str,
        display_name: str,
        config: dict[str, Any],
    ) -> str:
        config_id = uuid.uuid4().hex[:16]
        now = self._now()
        with self._lock:
            self._conn.execute(
                "INSERT INTO adapter_configs (id, adapter_type, display_name, config_json, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (config_id, adapter_type, display_name, json.dumps(config), now, now),
            )
            self._conn.commit()
        return config_id

    def list_adapter_configs(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, adapter_type, display_name, config_json, is_active, created_at, updated_at "
                "FROM adapter_configs ORDER BY created_at"
            ).fetchall()
        return [
            {
                "id": r["id"],
                "adapter_type": r["adapter_type"],
                "display_name": r["display_name"],
                "config": json.loads(r["config_json"]),
                "is_active": bool(r["is_active"]),
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
            }
            for r in rows
        ]

    def get_adapter_config(self, config_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT id, adapter_type, display_name, config_json, is_active, created_at, updated_at "
                "FROM adapter_configs WHERE id = ?",
                (config_id,),
            ).fetchone()
        if row is None:
            return None
        return {
            "id": row["id"],
            "adapter_type": row["adapter_type"],
            "display_name": row["display_name"],
            "config": json.loads(row["config_json"]),
            "is_active": bool(row["is_active"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def update_adapter_config(
        self,
        config_id: str,
        *,
        display_name: str | None = None,
        config: dict[str, Any] | None = None,
    ) -> None:
        now = self._now()
        with self._lock:
            if display_name is not None:
                self._conn.execute(
                    "UPDATE adapter_configs SET display_name = ?, updated_at = ? WHERE id = ?",
                    (display_name, now, config_id),
                )
            if config is not None:
                self._conn.execute(
                    "UPDATE adapter_configs SET config_json = ?, updated_at = ? WHERE id = ?",
                    (json.dumps(config), now, config_id),
                )
            self._conn.commit()

    def delete_adapter_config(self, config_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM adapter_configs WHERE id = ?", (config_id,))
            self._conn.commit()

    def set_active_adapter(self, config_id: str) -> None:
        with self._lock:
            self._conn.execute("UPDATE adapter_configs SET is_active = 0")
            self._conn.execute(
                "UPDATE adapter_configs SET is_active = 1 WHERE id = ?",
                (config_id,),
            )
            self._conn.commit()

    def get_active_adapter_config(self) -> dict[str, Any] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT id, adapter_type, display_name, config_json, is_active, created_at, updated_at "
                "FROM adapter_configs WHERE is_active = 1",
            ).fetchone()
        if row is None:
            return None
        return {
            "id": row["id"],
            "adapter_type": row["adapter_type"],
            "display_name": row["display_name"],
            "config": json.loads(row["config_json"]),
            "is_active": True,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    # -- Bot instances -----------------------------------------------------

    def save_bot_instance(
        self,
        adapter_config_id: str,
        bot_id: str,
        name: str,
        session_key: str,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        instance_id = uuid.uuid4().hex[:16]
        now = self._now()
        with self._lock:
            self._conn.execute(
                "INSERT INTO bot_instances "
                "(id, adapter_config_id, bot_id, name, session_key, metadata_json, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (instance_id, adapter_config_id, bot_id, name, session_key, json.dumps(metadata or {}), now, now),
            )
            self._conn.commit()
        return instance_id

    def list_bot_instances(self, adapter_config_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, adapter_config_id, bot_id, name, session_key, metadata_json, "
                "is_active, created_at, updated_at "
                "FROM bot_instances WHERE adapter_config_id = ? ORDER BY created_at",
                (adapter_config_id,),
            ).fetchall()
        return [
            {
                "id": r["id"],
                "adapter_config_id": r["adapter_config_id"],
                "bot_id": r["bot_id"],
                "name": r["name"],
                "session_key": r["session_key"],
                "metadata": json.loads(r["metadata_json"]),
                "is_active": bool(r["is_active"]),
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
            }
            for r in rows
        ]

    def delete_bot_instance(self, instance_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM bot_instances WHERE id = ?", (instance_id,))
            self._conn.commit()

    # -- Bot summaries -----------------------------------------------------

    def get_bot_summaries(self, bot_ids: list[str]) -> dict[str, str]:
        """Return {bot_id: summary} for bots with non-empty summaries."""
        if not bot_ids:
            return {}
        with self._lock:
            placeholders = ",".join("?" for _ in bot_ids)
            rows = self._conn.execute(
                f"SELECT bot_id, summary FROM bot_summaries WHERE bot_id IN ({placeholders}) AND summary != ''",
                bot_ids,
            ).fetchall()
        return {r["bot_id"]: r["summary"] for r in rows}

    def set_bot_summary(self, bot_id: str, summary: str) -> None:
        """Upsert bot summary with current timestamp."""
        now = self._now()
        with self._lock:
            self._conn.execute(
                "INSERT INTO bot_summaries (bot_id, summary, generated_at) "
                "VALUES (?, ?, ?) "
                "ON CONFLICT(bot_id) DO UPDATE SET summary=excluded.summary, generated_at=excluded.generated_at",
                (bot_id, summary, now),
            )
            self._conn.commit()

    def is_summary_attempted(self, bot_id: str) -> bool:
        """Check if summary generation was attempted (even if failed)."""
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM bot_summaries WHERE bot_id = ? AND generated_at != ''",
                (bot_id,),
            ).fetchone()
        return row is not None

    def get_unattempted_bot_ids(self, bot_ids: list[str]) -> list[str]:
        """Return bot_ids that have no summary attempt yet."""
        if not bot_ids:
            return []
        with self._lock:
            placeholders = ",".join("?" for _ in bot_ids)
            rows = self._conn.execute(
                f"SELECT bot_id FROM bot_summaries WHERE bot_id IN ({placeholders})",
                bot_ids,
            ).fetchall()
        attempted = {r["bot_id"] for r in rows}
        return [bid for bid in bot_ids if bid not in attempted]

    # -- App settings ------------------------------------------------------

    def _get_setting(self, key: str) -> str:
        with self._lock:
            row = self._conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
        return str(row["value"]) if row else ""

    def _set_setting(self, key: str, value: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO app_settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )
            self._conn.commit()

    def get_summary_llm_config(self) -> dict[str, str] | None:
        """Return summary LLM config or None if incomplete."""
        api_url = self._get_setting("summary_llm_api_url").strip()
        api_key = self._get_setting("summary_llm_api_key").strip()
        model = self._get_setting("summary_llm_model").strip()
        if not api_url or not api_key or not model:
            return None
        return {"api_url": api_url, "api_key": api_key, "model": model}

    def set_summary_llm_config(self, api_url: str, api_key: str, model: str) -> None:
        self._set_setting("summary_llm_api_url", api_url)
        self._set_setting("summary_llm_api_key", api_key)
        self._set_setting("summary_llm_model", model)
