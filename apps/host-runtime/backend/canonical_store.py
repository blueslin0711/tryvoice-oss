"""
Canonical conversation event store.

Agent sessions history is mirrored into an idempotent event table. A per-bot
revision is incremented only when canonical content changes. Telegram mirroring
is handled via a persistent outbox for retryable delivery.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

from backend.config import (
    CANONICAL_EVENT_V2_DUAL_WRITE,
    CANONICAL_EVENT_V2_READ_ENABLED,
)

EVENT_TABLE_V1 = "canonical_events"
EVENT_TABLE_V2 = "canonical_events_v2"


class CanonicalHistoryStore:
    def __init__(self, db_path: str):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()
        self._dual_write_v2 = bool(CANONICAL_EVENT_V2_DUAL_WRITE)
        self._read_from_v2 = bool(CANONICAL_EVENT_V2_READ_ENABLED)
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False, timeout=10)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._init_schema()

    def get_read_model(self) -> str:
        with self._lock:
            return "v2" if self._read_from_v2 else "v1"

    def get_dual_write_enabled(self) -> bool:
        with self._lock:
            return bool(self._dual_write_v2)

    def set_read_model(self, model: str) -> str:
        normalized = str(model or "").strip().lower()
        if normalized not in {"v1", "v2"}:
            raise ValueError("read model must be 'v1' or 'v2'")
        with self._lock:
            self._read_from_v2 = normalized == "v2"
            if self._read_from_v2:
                # Ensure v2 is always populated before serving reads from it.
                cur = self._conn.cursor()
                cur.execute("BEGIN")
                try:
                    self._backfill_v2_from_v1(cur)
                    self._conn.commit()
                except Exception:
                    self._conn.rollback()
                    raise
            return "v2" if self._read_from_v2 else "v1"

    def _active_event_table(self) -> str:
        return EVENT_TABLE_V2 if self._read_from_v2 else EVENT_TABLE_V1

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def clear_bot_history(self, bot_id: str, session_key: str) -> None:
        """Hard-clear canonical history for a bot.

        Used when the user requests a new session. This only affects
        the *voice-chat web UI* canonical store (SQLite). It does not delete
        agent session transcripts.
        """
        bid = str(bot_id)
        sk = str(session_key)
        with self._lock:
            cur = self._conn.cursor()
            cur.execute("BEGIN")
            try:
                cur.execute(f"DELETE FROM {EVENT_TABLE_V1} WHERE bot_id = ?", (bid,))
                cur.execute(f"DELETE FROM {EVENT_TABLE_V2} WHERE bot_id = ?", (bid,))
                # Reset sync cursor/state; bumping revision isn't necessary because
                # the client clears cache locally, and the next sync will emit a
                # fresh revision from replace_bot_snapshot.
                cur.execute(
                    "DELETE FROM canonical_sync_state WHERE bot_id = ?",
                    (bid,),
                )
                cur.execute(
                    "INSERT INTO canonical_sync_state"
                    " (bot_id, session_key, last_remote_count, last_error,"
                    " history_revision, last_mirrored_seq)"
                    " VALUES (?, ?, 0, '', 0, -1)",
                    (bid, sk),
                )
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise

    def _init_schema(self) -> None:
        with self._lock:
            cur = self._conn.cursor()
            cur.executescript(
                """
                CREATE TABLE IF NOT EXISTS canonical_events (
                    event_key TEXT PRIMARY KEY,
                    bot_id TEXT NOT NULL,
                    session_key TEXT NOT NULL,
                    seq INTEGER NOT NULL,
                    role TEXT NOT NULL,
                    text_raw TEXT NOT NULL,
                    text_display TEXT NOT NULL,
                    source_ts TEXT NOT NULL,
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                );

                CREATE INDEX IF NOT EXISTS idx_canonical_events_bot_seq
                ON canonical_events (bot_id, seq);

                CREATE TABLE IF NOT EXISTS canonical_events_v2 (
                    event_key TEXT PRIMARY KEY,
                    bot_id TEXT NOT NULL,
                    session_key TEXT NOT NULL,
                    seq INTEGER NOT NULL,
                    event_type TEXT NOT NULL DEFAULT 'message',
                    role TEXT NOT NULL,
                    text_raw TEXT NOT NULL,
                    text_display TEXT NOT NULL,
                    source_ts TEXT NOT NULL,
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    event_version INTEGER NOT NULL DEFAULT 2,
                    message_id INTEGER,
                    server_seq INTEGER,
                    synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                );

                CREATE INDEX IF NOT EXISTS idx_canonical_events_v2_bot_seq
                ON canonical_events_v2 (bot_id, seq);

                CREATE INDEX IF NOT EXISTS idx_canonical_events_v2_bot_server_seq
                ON canonical_events_v2 (bot_id, server_seq);

                CREATE TABLE IF NOT EXISTS canonical_sync_state (
                    bot_id TEXT PRIMARY KEY,
                    session_key TEXT NOT NULL,
                    last_synced_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    last_remote_count INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT NOT NULL DEFAULT '',
                    history_revision INTEGER NOT NULL DEFAULT 0,
                    last_mirrored_seq INTEGER NOT NULL DEFAULT -1
                );

                CREATE TABLE IF NOT EXISTS telegram_outbox (
                    outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_key TEXT NOT NULL,
                    bot_id TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    target TEXT NOT NULL,
                    message_text TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    retry_count INTEGER NOT NULL DEFAULT 0,
                    next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    last_error TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    sent_at TEXT NOT NULL DEFAULT '',
                    UNIQUE(event_key, target)
                );

                CREATE INDEX IF NOT EXISTS idx_outbox_status_attempt
                ON telegram_outbox (status, next_attempt_at, outbox_id);

                CREATE TABLE IF NOT EXISTS mirror_outbox (
                    outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_key TEXT NOT NULL,
                    channel TEXT NOT NULL,
                    bot_id TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    target TEXT NOT NULL,
                    message_text TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    retry_count INTEGER NOT NULL DEFAULT 0,
                    next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    last_error TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    sent_at TEXT NOT NULL DEFAULT '',
                    UNIQUE(event_key, channel, target)
                );

                CREATE INDEX IF NOT EXISTS idx_mirror_outbox_status_attempt
                ON mirror_outbox (status, next_attempt_at, outbox_id);
                """
            )
            self._ensure_events_columns(cur)
            self._ensure_sync_state_columns(cur)
            self._fix_server_seq_order(cur)
            self._ensure_events_v2_columns(cur)
            self._ensure_adapter_config_id_column(cur)
            self._ensure_source_channel_column(cur)
            self._migrate_event_key_composite_pk(cur)
            # Backfill once at startup so v2 reads and consistency checks are deterministic.
            self._backfill_v2_from_v1(cur)
            self._conn.commit()

    @staticmethod
    def _row_sig(row: sqlite3.Row) -> tuple[str, str, str, str]:
        """Content-only signature for change detection (no positional fields)."""
        return (
            str(row["event_key"]),
            str(row["text_raw"]),
            str(row["text_display"]),
            str(row["source_ts"]),
        )

    def _ensure_sync_state_columns(self, cur: sqlite3.Cursor) -> None:
        cols = {str(r["name"]) for r in cur.execute("PRAGMA table_info(canonical_sync_state)").fetchall()}
        if "history_revision" not in cols:
            cur.execute("ALTER TABLE canonical_sync_state ADD COLUMN history_revision INTEGER NOT NULL DEFAULT 0")
        if "last_mirrored_seq" not in cols:
            cur.execute("ALTER TABLE canonical_sync_state ADD COLUMN last_mirrored_seq INTEGER NOT NULL DEFAULT -1")
        if "last_read_seq" not in cols:
            cur.execute("ALTER TABLE canonical_sync_state ADD COLUMN last_read_seq INTEGER NOT NULL DEFAULT 0")
            # Backfill: set last_read_seq to each bot's current maxServerSeq
            # so existing messages aren't counted as unread on first run.
            cur.execute("""
                UPDATE canonical_sync_state
                SET last_read_seq = COALESCE(
                    (SELECT MAX(server_seq) FROM canonical_events
                     WHERE canonical_events.bot_id = canonical_sync_state.bot_id),
                    0
                )
            """)
        else:
            # Backfill: if column exists but was left at 0 (from a prior
            # migration without backfill), set it to maxServerSeq now.
            cur.execute("""
                UPDATE canonical_sync_state
                SET last_read_seq = COALESCE(
                    (SELECT MAX(server_seq) FROM canonical_events
                     WHERE canonical_events.bot_id = canonical_sync_state.bot_id),
                    0
                )
                WHERE last_read_seq = 0
            """)

    def _ensure_events_columns(self, cur: sqlite3.Cursor) -> None:
        """Migration: add message_id and server_seq columns to canonical_events."""
        cols = {str(r["name"]) for r in cur.execute("PRAGMA table_info(canonical_events)").fetchall()}

        if "message_id" not in cols:
            cur.execute("ALTER TABLE canonical_events ADD COLUMN message_id INTEGER")
            # Backfill from rowid
            cur.execute("UPDATE canonical_events SET message_id = rowid WHERE message_id IS NULL")

        if "server_seq" not in cols:
            cur.execute("ALTER TABLE canonical_events ADD COLUMN server_seq INTEGER")
            # Backfill: assign server_seq per bot based on existing ordering
            bots = cur.execute("SELECT DISTINCT bot_id FROM canonical_events").fetchall()
            for bot_row in bots:
                bid = bot_row["bot_id"]
                rows = cur.execute(
                    """
                    SELECT event_key FROM canonical_events
                    WHERE bot_id = ?
                    ORDER BY source_ts ASC, seq ASC
                    """,
                    (bid,),
                ).fetchall()
                for i, r in enumerate(rows):
                    cur.execute(
                        "UPDATE canonical_events SET server_seq = ? WHERE event_key = ? AND bot_id = ?",
                        (i + 1, r["event_key"], bid),
                    )
            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_canonical_events_bot_server_seq
                ON canonical_events (bot_id, server_seq)
                """
            )

    def _ensure_events_v2_columns(self, cur: sqlite3.Cursor) -> None:
        cols = {str(r["name"]) for r in cur.execute("PRAGMA table_info(canonical_events_v2)").fetchall()}
        if "message_id" not in cols:
            cur.execute("ALTER TABLE canonical_events_v2 ADD COLUMN message_id INTEGER")
        if "server_seq" not in cols:
            cur.execute("ALTER TABLE canonical_events_v2 ADD COLUMN server_seq INTEGER")
        if "event_type" not in cols:
            cur.execute("ALTER TABLE canonical_events_v2 ADD COLUMN event_type TEXT NOT NULL DEFAULT 'message'")
        if "event_version" not in cols:
            cur.execute("ALTER TABLE canonical_events_v2 ADD COLUMN event_version INTEGER NOT NULL DEFAULT 2")
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_canonical_events_v2_bot_server_seq
            ON canonical_events_v2 (bot_id, server_seq)
            """
        )

    def _ensure_adapter_config_id_column(self, cur: sqlite3.Cursor) -> None:
        """Migration: add adapter_config_id column for adapter-based history grouping."""
        for table in (EVENT_TABLE_V1, EVENT_TABLE_V2):
            cols = {str(r["name"]) for r in cur.execute(f"PRAGMA table_info({table})").fetchall()}
            if "adapter_config_id" not in cols:
                cur.execute(f"ALTER TABLE {table} ADD COLUMN adapter_config_id TEXT DEFAULT ''")

    def _ensure_source_channel_column(self, cur: sqlite3.Cursor) -> None:
        """Migration: add source_channel column for inbound channel attribution."""
        for table in (EVENT_TABLE_V1, EVENT_TABLE_V2):
            cols = {str(r["name"]) for r in cur.execute(f"PRAGMA table_info({table})").fetchall()}
            if "source_channel" not in cols:
                cur.execute(f"ALTER TABLE {table} ADD COLUMN source_channel TEXT NOT NULL DEFAULT 'web'")

    def _migrate_event_key_composite_pk(self, cur: sqlite3.Cursor) -> None:
        """Migration: change PRIMARY KEY from (event_key) to (event_key, bot_id).

        Without this, two bots in the same directory share event_keys from the
        same JSONL file. The first bot to insert "owns" the key; the second
        bot's INSERT silently fails, causing perpetual NEW_KEY change detection.
        """
        for table in (EVENT_TABLE_V1, EVENT_TABLE_V2):
            # Check current schema: if PRIMARY KEY is already composite, skip
            schema = cur.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
                (table,),
            ).fetchone()
            if schema is None:
                continue
            ddl = str(schema["sql"])
            ddl_compact = ddl.lower().replace(" ", "")
            # Already migrated if event_key is NOT a PRIMARY KEY
            # (migrated tables use UNIQUE(event_key, bot_id) instead)
            if "event_keytextprimarykey" not in ddl_compact:
                continue

            from loguru import logger

            logger.info(f"Migrating {table}: event_key PK → (event_key, bot_id) UNIQUE")

            cols = [str(r["name"]) for r in cur.execute(f"PRAGMA table_info({table})").fetchall()]
            cols_csv = ", ".join(cols)
            tmp = f"_tmp_{table}"

            # Build new CREATE TABLE with composite UNIQUE instead of single PK
            new_ddl = ddl.replace(
                "event_key TEXT PRIMARY KEY",
                "event_key TEXT NOT NULL",
            )
            # Add composite UNIQUE constraint before the closing paren
            # Find the last ')' and insert before it
            last_paren = new_ddl.rfind(")")
            new_ddl = new_ddl[:last_paren] + ",\n    UNIQUE(event_key, bot_id)" + new_ddl[last_paren:]
            # Rename to tmp table name
            new_ddl = new_ddl.replace(f"CREATE TABLE IF NOT EXISTS {table}", f"CREATE TABLE {tmp}", 1)
            new_ddl = new_ddl.replace(f"CREATE TABLE {table}", f"CREATE TABLE {tmp}", 1)

            cur.execute(new_ddl)
            cur.execute(f"INSERT OR IGNORE INTO {tmp} ({cols_csv}) SELECT {cols_csv} FROM {table}")
            cur.execute(f"DROP TABLE {table}")
            cur.execute(f"ALTER TABLE {tmp} RENAME TO {table}")
            logger.info(f"Migration complete: {table} now has UNIQUE(event_key, bot_id)")

    def _backfill_v2_from_v1(self, cur: sqlite3.Cursor) -> None:
        if not (self._dual_write_v2 or self._read_from_v2):
            return
        rows = cur.execute(
            """
            SELECT
                event_key, bot_id, session_key, seq, role, text_raw,
                text_display, source_ts, payload_json, message_id, server_seq,
                adapter_config_id, source_channel
            FROM canonical_events
            ORDER BY bot_id ASC, seq ASC
            """
        ).fetchall()
        if not rows:
            return
        cur.executemany(
            """
            INSERT INTO canonical_events_v2 (
                event_key, bot_id, session_key, seq, event_type, role,
                text_raw, text_display, source_ts, payload_json, event_version,
                message_id, server_seq, adapter_config_id, source_channel
            ) VALUES (?, ?, ?, ?, 'message', ?, ?, ?, ?, ?, 2, ?, ?, ?, ?)
            ON CONFLICT(event_key, bot_id) DO UPDATE SET
                session_key = excluded.session_key,
                seq = excluded.seq,
                event_type = excluded.event_type,
                role = excluded.role,
                text_raw = excluded.text_raw,
                text_display = excluded.text_display,
                source_ts = excluded.source_ts,
                payload_json = excluded.payload_json,
                event_version = excluded.event_version,
                message_id = excluded.message_id,
                server_seq = excluded.server_seq,
                adapter_config_id = excluded.adapter_config_id,
                source_channel = excluded.source_channel,
                synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE bot_id = excluded.bot_id
            """,
            [
                (
                    str(r["event_key"]),
                    str(r["bot_id"]),
                    str(r["session_key"]),
                    int(r["seq"]),
                    str(r["role"]),
                    str(r["text_raw"]),
                    str(r["text_display"]),
                    str(r["source_ts"]),
                    str(r["payload_json"] or "{}"),
                    int(r["message_id"]) if r["message_id"] is not None else None,
                    int(r["server_seq"]) if r["server_seq"] is not None else None,
                    str(r["adapter_config_id"] or ""),
                    str(r["source_channel"] or "web"),
                )
                for r in rows
            ],
        )

    def _sync_v2_for_bot(self, cur: sqlite3.Cursor, bot_id: str) -> None:
        if not (self._dual_write_v2 or self._read_from_v2):
            return
        rows = cur.execute(
            """
            SELECT
                event_key, bot_id, session_key, seq, role, text_raw,
                text_display, source_ts, payload_json, message_id, server_seq,
                adapter_config_id, source_channel
            FROM canonical_events
            WHERE bot_id = ?
            ORDER BY seq ASC
            """,
            (bot_id,),
        ).fetchall()
        if not rows:
            return
        cur.executemany(
            """
            INSERT INTO canonical_events_v2 (
                event_key, bot_id, session_key, seq, event_type, role,
                text_raw, text_display, source_ts, payload_json, event_version,
                message_id, server_seq, adapter_config_id, source_channel
            ) VALUES (?, ?, ?, ?, 'message', ?, ?, ?, ?, ?, 2, ?, ?, ?, ?)
            ON CONFLICT(event_key, bot_id) DO UPDATE SET
                session_key = excluded.session_key,
                seq = excluded.seq,
                event_type = excluded.event_type,
                role = excluded.role,
                text_raw = excluded.text_raw,
                text_display = excluded.text_display,
                source_ts = excluded.source_ts,
                payload_json = excluded.payload_json,
                event_version = excluded.event_version,
                message_id = excluded.message_id,
                server_seq = excluded.server_seq,
                adapter_config_id = excluded.adapter_config_id,
                source_channel = excluded.source_channel,
                synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE bot_id = excluded.bot_id
            """,
            [
                (
                    str(r["event_key"]),
                    str(r["bot_id"]),
                    str(r["session_key"]),
                    int(r["seq"]),
                    str(r["role"]),
                    str(r["text_raw"]),
                    str(r["text_display"]),
                    str(r["source_ts"]),
                    str(r["payload_json"] or "{}"),
                    int(r["message_id"]) if r["message_id"] is not None else None,
                    int(r["server_seq"]) if r["server_seq"] is not None else None,
                    str(r["adapter_config_id"] or ""),
                    str(r["source_channel"] or "web"),
                )
                for r in rows
            ],
        )

    def _fix_server_seq_order(self, cur: sqlite3.Cursor) -> None:
        """Startup migration: fix any existing out-of-order server_seq values.

        Checks each bot's messages: if server_seq is not monotonically
        increasing when sorted chronologically (source_ts ASC, seq ASC),
        reassigns all server_seq starting from (current_max + 1).
        Idempotent -- skips bots that are already correctly ordered.
        """
        for bot_row in cur.execute("SELECT DISTINCT bot_id FROM canonical_events").fetchall():
            bid = bot_row["bot_id"]
            rows = cur.execute(
                "SELECT event_key, server_seq FROM canonical_events WHERE bot_id = ? ORDER BY source_ts ASC, seq ASC",
                (bid,),
            ).fetchall()
            if not rows:
                continue
            prev_seq = -1
            needs_fix = False
            for r in rows:
                s = r["server_seq"]
                if s is None or s <= prev_seq:
                    needs_fix = True
                    break
                prev_seq = s
            if needs_fix:
                # Reassign from 1 (not old_max+1) to keep sequences compact.
                # Starting from old_max+1 causes all seqs to shift upward on
                # every restart, invalidating frontend afterSeq cursors.
                for i, r in enumerate(rows):
                    cur.execute(
                        "UPDATE canonical_events SET server_seq = ? WHERE event_key = ? AND bot_id = ?",
                        (i + 1, r["event_key"], bid),
                    )

    def replace_bot_snapshot(
        self,
        bot_id: str,
        session_key: str,
        messages: list[dict],
        adapter_config_id: str = "",
    ) -> dict:
        acid = str(adapter_config_id or "")
        rows = []
        incoming_sig = []
        # ISSUE-24 fix: deduplicate incoming messages by content signature.
        # Different event_keys can be generated for the same message when
        # the JSONL payload metadata varies across fetch_history calls.
        # Keep the first occurrence when (role, text_raw, source_ts) collide.
        # TODO(ISSUE-24b-cleanup): Remove after uuid-based eventKeys are validated.
        _seen_content: set[tuple[str, str, str]] = set()
        seq_idx = 0
        for msg in messages:
            event_key = str(msg.get("event_key", ""))
            role = str(msg.get("role", ""))
            text_raw = str(msg.get("text_raw", ""))
            text_display = str(msg.get("text_display", ""))
            source_ts = str(msg.get("source_ts", ""))
            payload_json = str(msg.get("payload_json", "{}"))
            source_channel = str(msg.get("source_channel", "web"))
            content_sig = (role, text_raw, source_ts)
            if content_sig in _seen_content:
                continue  # skip content-duplicate with different event_key
            _seen_content.add(content_sig)
            rows.append(
                (
                    event_key,
                    bot_id,
                    session_key,
                    seq_idx,
                    role,
                    text_raw,
                    text_display,
                    source_ts,
                    payload_json,
                    acid,
                    source_channel,
                )
            )
            incoming_sig.append((event_key, text_raw, text_display, source_ts))
            seq_idx += 1

        with self._lock:
            cur = self._conn.cursor()
            try:
                cur.execute("BEGIN")
                state = cur.execute(
                    """
                    SELECT session_key, history_revision, last_mirrored_seq
                    FROM canonical_sync_state
                    WHERE bot_id = ?
                    """,
                    (bot_id,),
                ).fetchone()
                prev_rows = cur.execute(
                    """
                    SELECT event_key, seq, text_raw, text_display, source_ts
                    FROM canonical_events
                    WHERE bot_id = ?
                    ORDER BY seq ASC
                    """,
                    (bot_id,),
                ).fetchall()
                _prev_sig = [self._row_sig(row) for row in prev_rows]
                session_switched = bool(state and str(state["session_key"]) != session_key)
                # Compare only the INCOMING messages against their corresponding DB entries
                # (by event_key). Append-only store means DB may have old messages not in incoming,
                # so full-list comparison would always show changed=True after compaction.
                prev_by_key = {row[0]: self._row_sig(row) for row in prev_rows}
                changed = session_switched
                if not changed:
                    for isig in incoming_sig:
                        ek = isig[0]  # event_key
                        if ek not in prev_by_key or prev_by_key[ek] != isig:
                            changed = True
                            break

                if rows:
                    cur.executemany(
                        """
                        INSERT INTO canonical_events (
                            event_key, bot_id, session_key, seq, role,
                            text_raw, text_display, source_ts, payload_json,
                            adapter_config_id, source_channel
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(event_key, bot_id) DO UPDATE SET
                            session_key = excluded.session_key,
                            seq = excluded.seq,
                            role = excluded.role,
                            text_raw = excluded.text_raw,
                            text_display = excluded.text_display,
                            source_ts = excluded.source_ts,
                            payload_json = excluded.payload_json,
                            adapter_config_id = excluded.adapter_config_id,
                            source_channel = excluded.source_channel,
                            synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                        WHERE bot_id = excluded.bot_id
                        """,
                        rows,
                    )
                    # NOTE: append-only -- do NOT delete old records.
                    # After agent compaction, old messages disappear from session
                    # history, but we keep them in canonical DB so Web UI retains
                    # full conversation history.
                    pass
                else:
                    # No incoming rows -- do NOT wipe; this can happen after compaction
                    pass

                # Assign message_id and server_seq for newly inserted rows
                cur.execute(
                    "UPDATE canonical_events SET message_id = rowid WHERE bot_id = ? AND message_id IS NULL",
                    (bot_id,),
                )
                null_seq_rows = cur.execute(
                    """
                    SELECT event_key, source_ts
                    FROM canonical_events
                    WHERE bot_id = ? AND server_seq IS NULL
                    ORDER BY source_ts ASC, seq ASC
                    """,
                    (bot_id,),
                ).fetchall()
                assigned_seqs: dict[str, int] = {}
                if null_seq_rows:
                    max_seq_row = cur.execute(
                        "SELECT COALESCE(MAX(server_seq), 0) AS ms FROM canonical_events WHERE bot_id = ?",
                        (bot_id,),
                    ).fetchone()
                    max_seq = int(max_seq_row["ms"])

                    # Append-only: only assign server_seq to new rows (NULL),
                    # always after the current max. Never reassign existing
                    # server_seq values — that would invalidate frontend cursors.
                    for i, r in enumerate(null_seq_rows):
                        new_seq = max_seq + i + 1
                        cur.execute(
                            "UPDATE canonical_events SET server_seq = ? WHERE event_key = ? AND bot_id = ?",
                            (new_seq, r["event_key"], bot_id),
                        )
                        assigned_seqs[r["event_key"]] = new_seq

                self._sync_v2_for_bot(cur, bot_id)

                prev_revision = int(state["history_revision"]) if state else 0
                revision = prev_revision + 1 if changed else prev_revision
                mirrored_seq = int(state["last_mirrored_seq"]) if state else -1
                if session_switched:
                    mirrored_seq = -1
                cur.execute(
                    """
                    INSERT INTO canonical_sync_state (
                        bot_id, session_key, last_remote_count, last_error,
                        history_revision, last_mirrored_seq
                    ) VALUES (?, ?, ?, '', ?, ?)
                    ON CONFLICT(bot_id) DO UPDATE SET
                        session_key = excluded.session_key,
                        last_remote_count = excluded.last_remote_count,
                        last_error = '',
                        history_revision = excluded.history_revision,
                        last_mirrored_seq = excluded.last_mirrored_seq,
                        last_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    """,
                    (bot_id, session_key, len(messages), revision, mirrored_seq),
                )
                max_seq_row = cur.execute(
                    "SELECT COALESCE(MAX(server_seq), 0) AS ms FROM canonical_events WHERE bot_id = ?",
                    (bot_id,),
                ).fetchone()
                self._conn.commit()
                return {
                    "changed": changed,
                    "revision": revision,
                    "count": len(messages),
                    "maxServerSeq": int(max_seq_row["ms"]) if max_seq_row else 0,
                    "assignedSeqs": assigned_seqs,
                }
            except Exception:
                self._conn.rollback()
                raise

    def upsert_event(
        self,
        *,
        bot_id: str,
        event_key: str,
        role: str,
        text: str,
        source_ts: str,
        session_key: str = "",
        stop_reason: str = "",
        model: str = "",
        content_kind: str = "",
    ) -> tuple[int, bool]:
        """Insert or update a single canonical event.

        Returns ``(serverSeq, is_new)`` where *is_new* is True when
        the event_key was freshly inserted (not previously known).

        *content_kind* (e.g. ``"thinking"``, ``"tool_call"``) is persisted
        in ``payload_json`` so that history sync responses include it for
        frontend granularity filtering.
        """
        bid = str(bot_id)
        ek = str(event_key)
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        payload = json.dumps({"contentKind": content_kind}) if content_kind else "{}"

        with self._lock:
            cur = self._conn.cursor()
            try:
                cur.execute("BEGIN")

                # Check if (event_key, bot_id) already exists
                existing = cur.execute(
                    "SELECT server_seq FROM canonical_events WHERE event_key = ? AND bot_id = ?",
                    (ek, bid),
                ).fetchone()

                is_new = existing is None
                if not is_new:
                    # UPDATE: text may have grown (streaming); refresh synced_at
                    cur.execute(
                        """
                        UPDATE canonical_events
                        SET text_raw = ?, text_display = ?, payload_json = ?, synced_at = ?
                        WHERE event_key = ? AND bot_id = ?
                        """,
                        (text, text, payload, now, ek, bid),
                    )
                    seq = int(existing["server_seq"])
                else:
                    # INSERT: assign next server_seq
                    max_seq_row = cur.execute(
                        "SELECT COALESCE(MAX(server_seq), 0) AS ms FROM canonical_events WHERE bot_id = ?",
                        (bid,),
                    ).fetchone()
                    seq = int(max_seq_row["ms"]) + 1

                    cur.execute(
                        """
                        INSERT INTO canonical_events (
                            event_key, bot_id, session_key, seq, role,
                            text_raw, text_display, source_ts, payload_json,
                            message_id, server_seq, synced_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
                        """,
                        (ek, bid, session_key, seq, role, text, text, source_ts, payload, seq, now),
                    )
                    # Backfill message_id from rowid
                    cur.execute(
                        "UPDATE canonical_events SET message_id = rowid "
                        "WHERE event_key = ? AND bot_id = ? AND message_id IS NULL",
                        (ek, bid),
                    )

                self._conn.commit()
                return seq, is_new
            except Exception:
                self._conn.rollback()
                raise

    def insert_boundary(
        self,
        *,
        bot_id: str,
        text: str,
        subtype: str = "reset",
        session_key: str = "",
    ) -> tuple[int, str]:
        """Insert a boundary event (role=system). Returns (serverSeq, eventKey)."""
        import uuid as _uuid

        bid = str(bot_id)
        ek = f"boundary-{_uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")

        with self._lock:
            cur = self._conn.cursor()
            try:
                cur.execute("BEGIN")
                max_seq_row = cur.execute(
                    "SELECT COALESCE(MAX(server_seq), 0) AS ms FROM canonical_events WHERE bot_id = ?",
                    (bid,),
                ).fetchone()
                seq = int(max_seq_row["ms"]) + 1
                cur.execute(
                    """
                    INSERT INTO canonical_events (
                        event_key, bot_id, session_key, seq, role,
                        text_raw, text_display, source_ts, payload_json,
                        message_id, server_seq, synced_at
                    ) VALUES (?, ?, ?, ?, 'system', ?, ?, ?, ?, NULL, ?, ?)
                    """,
                    (
                        ek,
                        bid,
                        session_key,
                        seq,
                        text,
                        text,
                        now,
                        json.dumps({"subtype": subtype}),
                        seq,
                        now,
                    ),
                )
                cur.execute(
                    "UPDATE canonical_events SET message_id = rowid "
                    "WHERE event_key = ? AND bot_id = ? AND message_id IS NULL",
                    (ek, bid),
                )
                self._conn.commit()
                return seq, ek
            except Exception:
                self._conn.rollback()
                raise

    def record_sync_error(self, bot_id: str, session_key: str, error: str) -> None:
        msg = (error or "").strip()[:400]
        with self._lock:
            cur = self._conn.cursor()
            state = cur.execute(
                """
                SELECT history_revision, last_mirrored_seq, last_remote_count
                FROM canonical_sync_state
                WHERE bot_id = ?
                """,
                (bot_id,),
            ).fetchone()
            revision = int(state["history_revision"]) if state else 0
            mirrored_seq = int(state["last_mirrored_seq"]) if state else -1
            remote_count = int(state["last_remote_count"]) if state else 0
            cur.execute(
                """
                INSERT INTO canonical_sync_state (
                    bot_id, session_key, last_remote_count, last_error,
                    history_revision, last_mirrored_seq
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(bot_id) DO UPDATE SET
                    session_key = excluded.session_key,
                    last_error = excluded.last_error,
                    history_revision = excluded.history_revision,
                    last_mirrored_seq = excluded.last_mirrored_seq,
                    last_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                """,
                (bot_id, session_key, remote_count, msg, revision, mirrored_seq),
            )
            self._conn.commit()

    def get_max_server_seq(self, bot_id: str) -> int:
        """Return the highest server_seq for a bot (0 if none)."""
        with self._lock:
            row = self._conn.execute(
                "SELECT COALESCE(MAX(server_seq), 0) AS ms FROM canonical_events WHERE bot_id = ?",
                (bot_id,),
            ).fetchone()
            return int(row["ms"]) if row else 0

    def get_last_read_seq(self, bot_id: str) -> int:
        """Return the last_read_seq for a bot (0 if not set)."""
        with self._lock:
            row = self._conn.execute(
                "SELECT last_read_seq FROM canonical_sync_state WHERE bot_id = ?",
                (bot_id,),
            ).fetchone()
            return int(row["last_read_seq"]) if row else 0

    def update_last_read_seq(self, bot_id: str, seq: int) -> None:
        """Set last_read_seq for a bot (only advances, never goes backwards)."""
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(
                """
                UPDATE canonical_sync_state
                SET last_read_seq = MAX(last_read_seq, ?)
                WHERE bot_id = ?
                """,
                (seq, bot_id),
            )
            self._conn.commit()

    @staticmethod
    def _dedup_and_filter(rows, extra_assistant_texts: set[str] | None = None):
        """Deduplicate rows and filter mirror echoes (user text == assistant text).

        Args:
            rows: message rows in chronological order (ASC by server_seq).
            extra_assistant_texts: optional pre-collected assistant texts for
                cross-batch mirror-echo detection (used by incremental sync).
        Returns:
            Filtered list of rows in chronological order.
        """
        # Pass 1: collect assistant texts for mirror-echo detection
        _assistant_texts: set[str] = set(extra_assistant_texts or [])
        for row in rows:
            if row["role"] == "assistant":
                _assistant_texts.add(row["text_display"].strip())

        # Pass 2: dedup by event_key, role|text fallback, and mirror-echo filter
        _seen_event_keys: set[str] = set()
        _seen_role_text: set[str] = set()
        deduped: list = []
        for row in rows:
            role = row["role"]
            text = row["text_display"].strip()
            event_key = row["event_key"].strip() if row["event_key"] else ""

            # Skip user message that exactly matches an assistant reply (mirror echo)
            if role == "user" and text in _assistant_texts:
                continue

            # Primary dedup: by event_key (unique per message)
            if event_key:
                if event_key in _seen_event_keys:
                    continue
                _seen_event_keys.add(event_key)
            else:
                # Fallback for messages without event_key: role|text dedup
                _dedup_key = f"{role}|{text}"
                if _dedup_key in _seen_role_text:
                    continue
                _seen_role_text.add(_dedup_key)
            deduped.append(row)
        return deduped

    @staticmethod
    def _rows_to_msgs(rows) -> list[dict]:
        msgs = []
        for row in rows:
            m: dict = {
                "role": row["role"],
                "text": row["text_display"],
                "textRaw": row["text_raw"],
                "eventKey": row["event_key"],
                "ts": row["source_ts"],
                "messageId": row["message_id"],
                "serverSeq": row["server_seq"],
                "sourceChannel": row["source_channel"] if "source_channel" in row.keys() else "web",
            }
            # Extract contentKind from payload_json so frontend can apply
            # granularity filtering on history-loaded messages (e.g. thinking).
            pj = row["payload_json"] if "payload_json" in row.keys() else "{}"
            try:
                payload = json.loads(pj) if pj else {}
            except (json.JSONDecodeError, TypeError):
                payload = {}
            ck = payload.get("contentKind", "")
            if ck:
                m["contentKind"] = ck
                if ck != "result":
                    m["intermediate"] = True
            msgs.append(m)
        return msgs

    def _sync_meta(self, state, max_seq_row) -> dict:
        return {
            "lastSyncedAt": state["last_synced_at"] if state else "",
            "remoteCount": int(state["last_remote_count"]) if state else 0,
            "lastError": state["last_error"] if state else "",
            "historyRevision": int(state["history_revision"]) if state else 0,
            "maxServerSeq": int(max_seq_row["ms"]) if max_seq_row else 0,
            "readModel": self.get_read_model(),
        }

    @staticmethod
    def _ts_sort_value(ts: str) -> int:
        raw = str(ts or "").strip()
        if not raw:
            return 0
        if raw.isdigit():
            try:
                return int(raw)
            except Exception:
                return 0
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            return int(dt.timestamp() * 1000)
        except Exception:
            return 0

    @staticmethod
    def _match_snippet(text: str, idx: int, qlen: int, radius: int = 36) -> str:
        src = str(text or "")
        if not src:
            return ""
        if idx < 0:
            return src[: min(120, len(src))]
        start = max(0, idx - radius)
        end = min(len(src), idx + max(1, qlen) + radius)
        prefix = "..." if start > 0 else ""
        suffix = "..." if end < len(src) else ""
        return f"{prefix}{src[start:end]}{suffix}"

    def _load_filtered_rows_for_bot(self, cur: sqlite3.Cursor, bot_id: str, table: str | None = None):
        event_table = table or self._active_event_table()
        rows = cur.execute(
            f"""
            SELECT role, text_display, source_ts, text_raw, event_key,
                   message_id, server_seq, source_channel, payload_json
            FROM {event_table}
            WHERE bot_id = ?
            ORDER BY server_seq ASC
            """,
            (bot_id,),
        ).fetchall()
        assistant_rows = cur.execute(
            f"SELECT DISTINCT text_display FROM {event_table} WHERE bot_id = ? AND role = 'assistant'",
            (bot_id,),
        ).fetchall()
        extra_asst = {r["text_display"].strip() for r in assistant_rows}
        return self._dedup_and_filter(rows, extra_assistant_texts=extra_asst)

    def search_history(
        self,
        query: str,
        *,
        limit: int = 50,
        bot_id: str | None = None,
    ) -> list[dict]:
        q = str(query or "").strip()
        if not q:
            return []
        lim = max(1, min(int(limit), 200))
        q_lower = q.lower()
        matches: list[dict] = []
        event_table = self._active_event_table()

        with self._lock:
            cur = self._conn.cursor()
            if bot_id:
                bot_ids = [str(bot_id)]
            else:
                bot_ids = [
                    str(r["bot_id"])
                    for r in cur.execute(f"SELECT DISTINCT bot_id FROM {event_table} ORDER BY bot_id ASC").fetchall()
                ]

            for bid in bot_ids:
                rows = self._load_filtered_rows_for_bot(cur, bid, table=event_table)
                for row in rows:
                    text = str(row["text_display"] or "")
                    idx = text.lower().find(q_lower)
                    if idx < 0:
                        continue
                    matches.append(
                        {
                            "botId": bid,
                            "role": str(row["role"]),
                            "text": text,
                            "textRaw": str(row["text_raw"] or ""),
                            "eventKey": str(row["event_key"] or ""),
                            "ts": str(row["source_ts"] or ""),
                            "messageId": row["message_id"],
                            "serverSeq": row["server_seq"],
                            "matchIndex": idx,
                            "snippet": self._match_snippet(text, idx, len(q)),
                        }
                    )

        matches.sort(
            key=lambda m: (
                self._ts_sort_value(str(m.get("ts", ""))),
                int(m.get("serverSeq") or 0),
            ),
            reverse=True,
        )
        return matches[:lim]

    def export_history(self, bot_id: str | None = None) -> dict:
        event_table = self._active_event_table()
        with self._lock:
            cur = self._conn.cursor()
            if bot_id:
                bot_ids = [str(bot_id)]
            else:
                bot_ids = [
                    str(r["bot_id"])
                    for r in cur.execute(f"SELECT DISTINCT bot_id FROM {event_table} ORDER BY bot_id ASC").fetchall()
                ]

            messages: list[dict] = []
            bot_counts: list[dict] = []
            for bid in bot_ids:
                rows = self._load_filtered_rows_for_bot(cur, bid, table=event_table)
                bot_counts.append({"botId": bid, "count": len(rows)})
                for row in rows:
                    messages.append(
                        {
                            "botId": bid,
                            "role": str(row["role"] or ""),
                            "text": str(row["text_display"] or ""),
                            "textRaw": str(row["text_raw"] or ""),
                            "eventKey": str(row["event_key"] or ""),
                            "ts": str(row["source_ts"] or ""),
                            "messageId": row["message_id"],
                            "serverSeq": row["server_seq"],
                        }
                    )

        messages.sort(
            key=lambda m: (
                self._ts_sort_value(str(m.get("ts", ""))),
                str(m.get("botId", "")),
                int(m.get("serverSeq") or 0),
            )
        )
        return {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "source": "canonical-db",
            "readModel": self.get_read_model(),
            "scope": {"botId": bot_id or ""},
            "summary": {
                "totalMessages": len(messages),
                "botCount": len(bot_counts),
                "bots": bot_counts,
            },
            "messages": messages,
        }

    def history_by_adapter(self) -> list[dict]:
        """Return all bots with their best-guess adapter_config_id and message counts.

        Each bot_id appears exactly once.  The adapter_config_id is resolved
        by picking the most-recent non-empty value stored on the bot's events
        (falls back to '' if none found).  This avoids duplicate rows when
        events for the same bot carry different adapter_config_id values.
        """
        event_table = self._active_event_table()
        with self._lock:
            cur = self._conn.cursor()
            rows = cur.execute(
                f"""
                SELECT
                    bot_id,
                    COUNT(*) AS msg_count,
                    MAX(source_ts) AS last_activity,
                    -- pick the latest non-empty adapter_config_id per bot
                    COALESCE(
                        (SELECT e2.adapter_config_id
                         FROM {event_table} e2
                         WHERE e2.bot_id = e1.bot_id AND e2.adapter_config_id != ''
                         ORDER BY e2.source_ts DESC LIMIT 1),
                        ''
                    ) AS adapter_config_id
                FROM {event_table} e1
                GROUP BY bot_id
                ORDER BY bot_id
                """
            ).fetchall()
        return [
            {
                "adapter_config_id": str(row["adapter_config_id"] or ""),
                "bot_id": str(row["bot_id"]),
                "msg_count": int(row["msg_count"]),
                "last_activity": str(row["last_activity"] or ""),
            }
            for row in rows
        ]

    def list_history(self, bot_id: str, limit: int) -> tuple[list[dict], dict]:
        lim = max(1, int(limit))
        event_table = self._active_event_table()
        with self._lock:
            cur = self._conn.cursor()
            rows = cur.execute(
                f"""
                SELECT role, text_display, source_ts, text_raw, event_key,
                       message_id, server_seq, payload_json
                FROM {event_table}
                WHERE bot_id = ?
                ORDER BY server_seq DESC
                LIMIT ?
                """,
                (bot_id, lim),
            ).fetchall()
            state = cur.execute(
                """
                SELECT
                    last_synced_at,
                    last_remote_count,
                    last_error,
                    history_revision
                FROM canonical_sync_state
                WHERE bot_id = ?
                """,
                (bot_id,),
            ).fetchone()
            max_seq_row = cur.execute(
                f"SELECT COALESCE(MAX(server_seq), 0) AS ms FROM {event_table} WHERE bot_id = ?",
                (bot_id,),
            ).fetchone()
            # Collect assistant texts from full history for cross-window echo detection
            # (consistent with list_history_incremental behaviour)
            assistant_rows = cur.execute(
                f"SELECT DISTINCT text_display FROM {event_table} WHERE bot_id = ? AND role = 'assistant'",
                (bot_id,),
            ).fetchall()

        extra_asst = {r["text_display"].strip() for r in assistant_rows}

        # Reverse DESC rows to chronological ASC, then dedup+filter
        deduped_rows = self._dedup_and_filter(list(reversed(rows)), extra_assistant_texts=extra_asst)
        return self._rows_to_msgs(deduped_rows), self._sync_meta(state, max_seq_row)

    def list_history_before(self, bot_id: str, before_seq: int, limit: int) -> tuple[list[dict], dict]:
        """Return messages with server_seq < before_seq, newest first, in ASC order."""
        lim = max(1, int(limit))
        bseq = int(before_seq)
        event_table = self._active_event_table()
        with self._lock:
            cur = self._conn.cursor()
            rows = cur.execute(
                f"""
                SELECT role, text_display, source_ts, text_raw, event_key,
                       message_id, server_seq, source_channel, payload_json
                FROM {event_table}
                WHERE bot_id = ? AND server_seq < ?
                ORDER BY server_seq DESC
                LIMIT ?
                """,
                (bot_id, bseq, lim),
            ).fetchall()
            min_returned_seq = rows[-1]["server_seq"] if rows else bseq
            has_more_row = cur.execute(
                f"SELECT EXISTS(SELECT 1 FROM {event_table} WHERE bot_id = ? AND server_seq < ?) AS e",
                (bot_id, min_returned_seq),
            ).fetchone()
            state = cur.execute(
                "SELECT last_synced_at, last_remote_count, last_error, history_revision "
                "FROM canonical_sync_state WHERE bot_id = ?",
                (bot_id,),
            ).fetchone()
            max_seq_row = cur.execute(
                f"SELECT COALESCE(MAX(server_seq), 0) AS ms FROM {event_table} WHERE bot_id = ?",
                (bot_id,),
            ).fetchone()
            assistant_rows = cur.execute(
                f"SELECT DISTINCT text_display FROM {event_table} WHERE bot_id = ? AND role = 'assistant'",
                (bot_id,),
            ).fetchall()

        extra_asst = {r["text_display"].strip() for r in assistant_rows}
        rows_asc = list(reversed(rows))
        deduped = self._dedup_and_filter(rows_asc, extra_assistant_texts=extra_asst)
        meta = self._sync_meta(state, max_seq_row)
        meta["hasMore"] = bool(has_more_row and has_more_row["e"])
        if deduped:
            meta["minServerSeq"] = deduped[0]["server_seq"]
            meta["maxServerSeq"] = deduped[-1]["server_seq"]
        return self._rows_to_msgs(deduped), meta

    def list_history_around(self, bot_id: str, around_seq: int, limit: int) -> tuple[list[dict], dict]:
        """Return messages centered on around_seq.

        Asymmetric clamping: if fewer messages exist on one side, don't pad
        from the other side.
        """
        half = max(1, int(limit) // 2)
        aseq = int(around_seq)
        event_table = self._active_event_table()
        with self._lock:
            cur = self._conn.cursor()
            # Before + target: server_seq <= around_seq, newest first
            before_rows = cur.execute(
                f"""
                SELECT role, text_display, source_ts, text_raw, event_key,
                       message_id, server_seq, source_channel, payload_json
                FROM {event_table}
                WHERE bot_id = ? AND server_seq <= ?
                ORDER BY server_seq DESC
                LIMIT ?
                """,
                (bot_id, aseq, half),
            ).fetchall()
            # After target: server_seq > around_seq, oldest first
            after_rows = cur.execute(
                f"""
                SELECT role, text_display, source_ts, text_raw, event_key,
                       message_id, server_seq, source_channel, payload_json
                FROM {event_table}
                WHERE bot_id = ? AND server_seq > ?
                ORDER BY server_seq ASC
                LIMIT ?
                """,
                (bot_id, aseq, half),
            ).fetchall()
            combined = list(reversed(before_rows)) + list(after_rows)
            min_seq = combined[0]["server_seq"] if combined else aseq
            has_more_row = cur.execute(
                f"SELECT EXISTS(SELECT 1 FROM {event_table} WHERE bot_id = ? AND server_seq < ?) AS e",
                (bot_id, min_seq),
            ).fetchone()
            state = cur.execute(
                "SELECT last_synced_at, last_remote_count, last_error, history_revision "
                "FROM canonical_sync_state WHERE bot_id = ?",
                (bot_id,),
            ).fetchone()
            max_seq_row = cur.execute(
                f"SELECT COALESCE(MAX(server_seq), 0) AS ms FROM {event_table} WHERE bot_id = ?",
                (bot_id,),
            ).fetchone()
            assistant_rows = cur.execute(
                f"SELECT DISTINCT text_display FROM {event_table} WHERE bot_id = ? AND role = 'assistant'",
                (bot_id,),
            ).fetchall()

        extra_asst = {r["text_display"].strip() for r in assistant_rows}
        deduped = self._dedup_and_filter(combined, extra_assistant_texts=extra_asst)
        meta = self._sync_meta(state, max_seq_row)
        meta["hasMore"] = bool(has_more_row and has_more_row["e"])
        if deduped:
            meta["minServerSeq"] = deduped[0]["server_seq"]
            meta["maxServerSeq"] = deduped[-1]["server_seq"]
        return self._rows_to_msgs(deduped), meta

    def list_history_incremental(self, bot_id: str, after_seq: int, limit: int) -> tuple[list[dict], dict]:
        """Return messages with server_seq > after_seq (for incremental sync)."""
        lim = max(1, int(limit))
        aseq = max(0, int(after_seq))
        event_table = self._active_event_table()
        with self._lock:
            cur = self._conn.cursor()
            rows = cur.execute(
                f"""
                SELECT role, text_display, source_ts, text_raw, event_key,
                       message_id, server_seq, source_channel, payload_json
                FROM {event_table}
                WHERE bot_id = ? AND server_seq > ?
                ORDER BY server_seq ASC
                LIMIT ?
                """,
                (bot_id, aseq, lim),
            ).fetchall()
            # Collect assistant texts from full history for cross-batch echo detection
            assistant_rows = cur.execute(
                f"SELECT DISTINCT text_display FROM {event_table} WHERE bot_id = ? AND role = 'assistant'",
                (bot_id,),
            ).fetchall()
            state = cur.execute(
                """
                SELECT
                    last_synced_at,
                    last_remote_count,
                    last_error,
                    history_revision
                FROM canonical_sync_state
                WHERE bot_id = ?
                """,
                (bot_id,),
            ).fetchone()
            max_seq_row = cur.execute(
                f"SELECT COALESCE(MAX(server_seq), 0) AS ms FROM {event_table} WHERE bot_id = ?",
                (bot_id,),
            ).fetchone()

        extra_asst = {r["text_display"].strip() for r in assistant_rows}
        deduped_rows = self._dedup_and_filter(rows, extra_assistant_texts=extra_asst)
        return self._rows_to_msgs(deduped_rows), self._sync_meta(state, max_seq_row)

    def compare_event_tables(self, bot_id: str | None = None) -> dict:
        with self._lock:
            cur = self._conn.cursor()
            if bot_id:
                bot_ids = [str(bot_id)]
            else:
                bot_ids = sorted(
                    {
                        str(r["bot_id"])
                        for r in cur.execute(
                            f"SELECT DISTINCT bot_id FROM {EVENT_TABLE_V1} "
                            f"UNION SELECT DISTINCT bot_id FROM {EVENT_TABLE_V2}"
                        ).fetchall()
                    }
                )

            per_bot: list[dict] = []
            total_v1 = 0
            total_v2 = 0
            total_matched = 0
            for bid in bot_ids:
                v1_keys = {
                    str(r["event_key"])
                    for r in cur.execute(
                        f"SELECT event_key FROM {EVENT_TABLE_V1} WHERE bot_id = ?",
                        (bid,),
                    ).fetchall()
                }
                v2_keys = {
                    str(r["event_key"])
                    for r in cur.execute(
                        f"SELECT event_key FROM {EVENT_TABLE_V2} WHERE bot_id = ?",
                        (bid,),
                    ).fetchall()
                }
                matched = len(v1_keys & v2_keys)
                miss_in_v2 = len(v1_keys - v2_keys)
                extra_in_v2 = len(v2_keys - v1_keys)
                total_v1 += len(v1_keys)
                total_v2 += len(v2_keys)
                total_matched += matched
                per_bot.append(
                    {
                        "botId": bid,
                        "v1Count": len(v1_keys),
                        "v2Count": len(v2_keys),
                        "matched": matched,
                        "missingInV2": miss_in_v2,
                        "extraInV2": extra_in_v2,
                        "consistencyRate": round((matched / len(v1_keys)) if v1_keys else 1.0, 6),
                    }
                )

            return {
                "readModel": "v2" if self._read_from_v2 else "v1",
                "dualWriteEnabled": bool(self._dual_write_v2),
                "summary": {
                    "botCount": len(per_bot),
                    "totalV1": total_v1,
                    "totalV2": total_v2,
                    "matched": total_matched,
                    "consistencyRate": round((total_matched / total_v1) if total_v1 else 1.0, 6),
                },
                "bots": per_bot,
            }

    def queue_telegram_mirror(
        self,
        bot_id: str,
        session_key: str,
        account_id: str,
        target: str,
        bot_name: str,
    ) -> int:
        with self._lock:
            cur = self._conn.cursor()
            try:
                cur.execute("BEGIN")
                state = cur.execute(
                    """
                    SELECT session_key, last_mirrored_seq
                    FROM canonical_sync_state
                    WHERE bot_id = ?
                    """,
                    (bot_id,),
                ).fetchone()
                if state is None:
                    self._conn.commit()
                    return 0

                last_mirrored_seq = int(state["last_mirrored_seq"])
                if str(state["session_key"]) != session_key:
                    last_mirrored_seq = -1

                rows = cur.execute(
                    """
                    SELECT seq, event_key, role, text_display
                    FROM canonical_events
                    WHERE bot_id = ? AND session_key = ? AND seq > ?
                    ORDER BY seq ASC
                    """,
                    (bot_id, session_key, last_mirrored_seq),
                ).fetchall()
                if not rows:
                    self._conn.commit()
                    return 0

                inserted = 0
                max_seq = last_mirrored_seq
                for row in rows:
                    max_seq = max(max_seq, int(row["seq"]))
                    text = str(row["text_display"] or "").strip()
                    if not text:
                        continue
                    role = str(row["role"])
                    if role == "assistant":
                        out_text = f"{bot_name}: {text}"
                    else:
                        out_text = f"\u4f60: {text}"
                    cur.execute(
                        """
                        INSERT INTO telegram_outbox (
                            event_key, bot_id, account_id, target, message_text
                        ) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(event_key, target) DO NOTHING
                        """,
                        (str(row["event_key"]), bot_id, account_id, target, out_text),
                    )
                    if cur.rowcount > 0:
                        inserted += 1

                cur.execute(
                    """
                    UPDATE canonical_sync_state
                    SET last_mirrored_seq = ?
                    WHERE bot_id = ?
                    """,
                    (max_seq, bot_id),
                )
                self._conn.commit()
                return inserted
            except Exception:
                self._conn.rollback()
                raise

    def list_pending_telegram_outbox(self, limit: int) -> list[dict]:
        lim = max(1, int(limit))
        with self._lock:
            cur = self._conn.cursor()
            rows = cur.execute(
                """
                SELECT outbox_id, account_id, target, message_text, retry_count
                FROM telegram_outbox
                WHERE status IN ('pending', 'retry')
                  AND next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                ORDER BY outbox_id ASC
                LIMIT ?
                """,
                (lim,),
            ).fetchall()
        return [dict(row) for row in rows]

    def enqueue_telegram_outbox(
        self,
        event_key: str,
        bot_id: str,
        account_id: str,
        target: str,
        message_text: str,
    ) -> bool:
        if not event_key:
            return False
        text = (message_text or "").strip()
        if not text:
            return False
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(
                """
                INSERT INTO telegram_outbox (
                    event_key, bot_id, account_id, target, message_text
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(event_key, target) DO NOTHING
                """,
                (str(event_key), bot_id, account_id, target, text),
            )
            inserted = cur.rowcount > 0
            self._conn.commit()
        return inserted

    def mark_telegram_sent(self, outbox_id: int) -> None:
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(
                """
                UPDATE telegram_outbox
                SET
                    status = 'sent',
                    sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    last_error = ''
                WHERE outbox_id = ?
                """,
                (int(outbox_id),),
            )
            self._conn.commit()

    def mark_telegram_retry(
        self,
        outbox_id: int,
        error: str,
        retry_delay_seconds: int,
        max_retries: int,
    ) -> None:
        err = (error or "").strip()[:400]
        delay = max(1, int(retry_delay_seconds))
        retries_limit = max(1, int(max_retries))
        with self._lock:
            cur = self._conn.cursor()
            row = cur.execute(
                "SELECT retry_count FROM telegram_outbox WHERE outbox_id = ?",
                (int(outbox_id),),
            ).fetchone()
            if row is None:
                return
            next_retry_count = int(row["retry_count"]) + 1
            if next_retry_count >= retries_limit:
                cur.execute(
                    """
                    UPDATE telegram_outbox
                    SET
                        status = 'failed',
                        retry_count = ?,
                        last_error = ?,
                        next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE outbox_id = ?
                    """,
                    (next_retry_count, err, int(outbox_id)),
                )
            else:
                cur.execute(
                    """
                    UPDATE telegram_outbox
                    SET
                        status = 'retry',
                        retry_count = ?,
                        last_error = ?,
                        next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
                    WHERE outbox_id = ?
                    """,
                    (next_retry_count, err, f"+{delay} seconds", int(outbox_id)),
                )
            self._conn.commit()

    def outbox_stats(self) -> dict:
        with self._lock:
            cur = self._conn.cursor()
            rows = cur.execute(
                """
                SELECT status, COUNT(1) AS cnt
                FROM telegram_outbox
                GROUP BY status
                """
            ).fetchall()
        stats = {"pending": 0, "retry": 0, "failed": 0, "sent": 0}
        for row in rows:
            status = str(row["status"])
            if status in stats:
                stats[status] = int(row["cnt"])
        return stats

    # ------------------------------------------------------------------
    # Generalized mirror outbox (multi-channel)
    # ------------------------------------------------------------------

    def enqueue_mirror_outbox(
        self,
        event_key: str,
        channel: str,
        bot_id: str,
        account_id: str,
        target: str,
        message_text: str,
    ) -> bool:
        if not event_key or not channel:
            return False
        text = (message_text or "").strip()
        if not text:
            return False
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(
                """
                INSERT INTO mirror_outbox (
                    event_key, channel, bot_id, account_id, target, message_text
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(event_key, channel, target) DO NOTHING
                """,
                (str(event_key), channel, bot_id, account_id, target, text),
            )
            inserted = cur.rowcount > 0
            self._conn.commit()
        return inserted

    def list_pending_mirror_outbox(self, limit: int) -> list[dict]:
        lim = max(1, int(limit))
        with self._lock:
            cur = self._conn.cursor()
            rows = cur.execute(
                """
                SELECT outbox_id, channel, bot_id, account_id, target,
                       message_text, retry_count
                FROM mirror_outbox
                WHERE status IN ('pending', 'retry')
                  AND next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                ORDER BY outbox_id ASC
                LIMIT ?
                """,
                (lim,),
            ).fetchall()
        return [dict(row) for row in rows]

    def mark_mirror_sent(self, outbox_id: int) -> None:
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(
                """
                UPDATE mirror_outbox
                SET
                    status = 'sent',
                    sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    last_error = ''
                WHERE outbox_id = ?
                """,
                (int(outbox_id),),
            )
            self._conn.commit()

    def mark_mirror_retry(
        self,
        outbox_id: int,
        error: str,
        retry_delay_seconds: int,
        max_retries: int,
    ) -> None:
        err = (error or "").strip()[:400]
        delay = max(1, int(retry_delay_seconds))
        retries_limit = max(1, int(max_retries))
        with self._lock:
            cur = self._conn.cursor()
            row = cur.execute(
                "SELECT retry_count FROM mirror_outbox WHERE outbox_id = ?",
                (int(outbox_id),),
            ).fetchone()
            if row is None:
                return
            next_retry_count = int(row["retry_count"]) + 1
            if next_retry_count >= retries_limit:
                cur.execute(
                    """
                    UPDATE mirror_outbox
                    SET
                        status = 'failed',
                        retry_count = ?,
                        last_error = ?,
                        next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE outbox_id = ?
                    """,
                    (next_retry_count, err, int(outbox_id)),
                )
            else:
                cur.execute(
                    """
                    UPDATE mirror_outbox
                    SET
                        status = 'retry',
                        retry_count = ?,
                        last_error = ?,
                        next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
                    WHERE outbox_id = ?
                    """,
                    (next_retry_count, err, f"+{delay} seconds", int(outbox_id)),
                )
            self._conn.commit()

    def mark_mirror_failed(self, outbox_id: int, error: str) -> None:
        err = (error or "").strip()[:400]
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(
                """
                UPDATE mirror_outbox
                SET status = 'failed', last_error = ?
                WHERE outbox_id = ?
                """,
                (err, int(outbox_id)),
            )
            self._conn.commit()

    def mirror_outbox_stats(self) -> dict:
        with self._lock:
            cur = self._conn.cursor()
            rows = cur.execute(
                """
                SELECT status, COUNT(1) AS cnt
                FROM mirror_outbox
                GROUP BY status
                """
            ).fetchall()
        stats = {"pending": 0, "retry": 0, "failed": 0, "sent": 0}
        for row in rows:
            status = str(row["status"])
            if status in stats:
                stats[status] = int(row["cnt"])
        return stats

    def reset_failed_mirror_outbox(self) -> int:
        """Reset all failed mirror outbox entries back to pending for retry."""
        with self._lock:
            cur = self._conn.cursor()
            cur.execute(
                """
                UPDATE mirror_outbox
                SET status = 'pending', retry_count = 0, last_error = '',
                    next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE status = 'failed'
                """
            )
            count = cur.rowcount
            self._conn.commit()
        return count

    def prune_history(self, retention_days: int = 0, max_per_bot: int = 0) -> dict:
        """Prune old messages based on retention policy.

        Args:
            retention_days: Delete messages older than N days (0 = disabled).
            max_per_bot: Keep only the most recent N messages per bot (0 = unlimited).

        Returns:
            dict with pruning stats: {"pruned_by_age": int, "pruned_by_count": int}
        """
        pruned_by_age = 0
        pruned_by_count = 0

        with self._lock:
            cur = self._conn.cursor()
            cur.execute("BEGIN")
            try:
                # --- Prune by age ---
                if retention_days > 0:
                    cutoff_ms = int((datetime.now(timezone.utc).timestamp() - retention_days * 86400) * 1000)
                    # source_ts can be epoch-ms string or ISO format
                    # For epoch-ms: CAST(source_ts AS INTEGER) < cutoff
                    for table in (EVENT_TABLE_V1, EVENT_TABLE_V2):
                        r = cur.execute(
                            f"DELETE FROM {table} WHERE CAST(source_ts AS INTEGER) > 0 "
                            f"AND CAST(source_ts AS INTEGER) < ?",
                            (cutoff_ms,),
                        )
                        pruned_by_age += r.rowcount

                # --- Prune by max messages per bot ---
                if max_per_bot > 0:
                    bot_rows = cur.execute(f"SELECT DISTINCT bot_id FROM {EVENT_TABLE_V1}").fetchall()
                    for bot_row in bot_rows:
                        bid = bot_row["bot_id"]
                        for table in (EVENT_TABLE_V1, EVENT_TABLE_V2):
                            count_row = cur.execute(
                                f"SELECT COUNT(1) AS cnt FROM {table} WHERE bot_id = ?",
                                (bid,),
                            ).fetchone()
                            total = int(count_row["cnt"]) if count_row else 0
                            excess = total - max_per_bot
                            if excess > 0:
                                r = cur.execute(
                                    f"DELETE FROM {table} WHERE bot_id = ? AND event_key IN ("
                                    f"  SELECT event_key FROM {table} WHERE bot_id = ? "
                                    f"  ORDER BY server_seq ASC LIMIT ?"
                                    f")",
                                    (bid, bid, excess),
                                )
                                pruned_by_count += r.rowcount

                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise

        return {"pruned_by_age": pruned_by_age, "pruned_by_count": pruned_by_count}
