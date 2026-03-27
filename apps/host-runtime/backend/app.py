"""
FastAPI app creation, lifespan, middleware, and server runner.
"""

import asyncio
import os
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from loguru import logger

from backend.adapter.registry import get_active_adapter_info
from backend.auth import (
    is_auth_enabled,
    is_public_http_path,
    is_request_authenticated,
    unauthorized_json_response,
)
from backend.canonical_store import CanonicalHistoryStore
from backend.config import (
    ACCESS_PASSWORD,
    CANONICAL_DB_PATH,
    CANONICAL_EVENT_V2_DUAL_WRITE,
    CANONICAL_EVENT_V2_READ_ENABLED,
    ENV_PATH,
    EXPOSE_BROWSER_STT_KEY,
    EXPOSE_PICOVOICE_KEY,
    HISTORY_MAX_MESSAGES_PER_BOT,
    HISTORY_RETENTION_DAYS,
    HISTORY_SYNC_FETCH_LIMIT,
    HISTORY_SYNC_INTERVAL_SECONDS,
    SERVER_LOG_FILE,
    SERVER_LOG_FORMAT,
    SERVER_LOG_LEVEL,
    SERVER_LOG_RETENTION,
    SERVER_LOG_ROTATION,
)
from backend.ops.metrics import record_exception, record_http
from backend.paths import (
    CERT_PATH as _USER_CERT_PATH,
)
from backend.paths import (
    KEY_PATH as _USER_KEY_PATH,
)
from backend.paths import (
    USER_DATA_DIR,
)
from backend.runtime.slot_registry import list_slots, slot_ids

# Shared history store instance
_history_store = CanonicalHistoryStore(CANONICAL_DB_PATH)

# Shared config store (adapter configurations)
from backend.config_store import ConfigStore  # noqa: E402

_config_store = ConfigStore(str(USER_DATA_DIR / "config.db"))


def get_history_store() -> CanonicalHistoryStore:
    return _history_store


def get_config_store() -> ConfigStore:
    return _config_store


def enrich_slots_from_gateway() -> int:
    """Enrich slot mirrorChannels and mirror defaults from gateway config.

    Reads openclaw.json for bot tokens and channel bindings, and
    sessions.json for Telegram chat IDs (mirror targets).  Safe to call
    multiple times (idempotent — only fills empty fields).

    NOTE: Session keys are NOT overridden here.  The gateway uses
    inter-session relay to forward Telegram messages into the agent's
    main session (e.g. agent:main:main).  Overriding the slot's
    sessionKey to the Telegram DM session would break this relay
    because the DM session is empty (messages live in the main session).

    Returns number of slots enriched.
    """
    try:
        from backend.adapter.openclaw.gateway import gateway_read_config
    except ImportError:
        return 0

    _oc_config = gateway_read_config()
    _acct_channels: dict[str, list[str]] = {}
    _acct_bot_tokens: dict[str, str] = {}
    for acct in _oc_config.get("accounts", []):
        aid = str(acct.get("accountId", "")).strip()
        ch = str(acct.get("channel", "")).strip()
        bt = str(acct.get("botToken", "")).strip()
        if aid and ch:
            _acct_channels.setdefault(aid, []).append(ch)
        if aid and bt:
            _acct_bot_tokens[aid] = bt

    # Extract telegram chat_id targets from gateway sessions.json
    # Session keys follow: agent:{agentId}:telegram:{account}:direct:{chat_id}
    _acct_chat_ids: dict[str, str] = {}
    try:
        import json as _j
        from pathlib import Path as _P

        _sessions_path = _P.home() / ".openclaw" / "agents" / "main" / "sessions" / "sessions.json"
        if _sessions_path.exists():
            _sessions_data = _j.loads(_sessions_path.read_text("utf-8"))
            for _skey in _sessions_data if isinstance(_sessions_data, dict) else {}:
                if ":telegram:" in _skey and ":direct:" in _skey:
                    _parts = _skey.split(":")
                    if len(_parts) >= 6:
                        _acct_chat_ids.setdefault(_parts[3], _parts[5])
    except Exception:
        pass

    from backend.runtime.slot_registry import enrich_mirror_channels

    enriched = enrich_mirror_channels(
        _acct_channels,
        mirror_defaults={
            aid: {
                "telegram": {
                    "target": _acct_chat_ids.get(aid, ""),
                    "token": _acct_bot_tokens.get(aid, ""),
                }
            }
            for aid in set(list(_acct_chat_ids) + list(_acct_bot_tokens))
        },
    )
    if enriched:
        logger.info(f"Enriched mirrorChannels for {enriched} slot(s) from openclaw.json")
    return enriched


@asynccontextmanager
async def lifespan(app):
    from backend import mirror

    # Migrate .env config to ConfigStore (one-time, idempotent)
    from backend.config_migration import migrate_env_to_store
    from backend.history import sync as history_sync
    from backend.ws.manager import broadcast_history_revision

    migrate_env_to_store(dict(os.environ), _config_store)

    # Load all adapter configs from ConfigStore and apply to each adapter
    from backend.adapter.registry import get_adapter, get_default_adapter

    for cfg in _config_store.list_adapter_configs():
        adapter_type = cfg["adapter_type"]
        try:
            adapter = get_adapter(adapter_type)
            if hasattr(adapter, "apply_config"):
                adapter.apply_config(cfg["config"])
                logger.info(f"Applied ConfigStore config to adapter '{adapter_type}'")
        except KeyError:
            logger.warning(f"ConfigStore adapter '{adapter_type}' not in registry")

    # Restore session_mode from shared_settings (persisted by frontend toggle)
    try:
        from backend.paths import SETTINGS_PATH

        if SETTINGS_PATH.exists():
            import json as _json

            _shared = _json.loads(SETTINGS_PATH.read_text("utf-8"))
            if "sessionMode" in _shared:
                _mode = "observer" if _shared["sessionMode"] == "observer" else "controller"
                adapter = get_adapter("claude-code")
                if hasattr(adapter, "apply_config"):
                    adapter.apply_config({"session_mode": _mode})
                    logger.info(f"Restored session_mode from shared_settings: {_mode}")
    except Exception as exc:
        logger.warning(f"Failed to restore session_mode from shared_settings: {exc}")

    # Enrich slot mirrorChannels + mirror defaults from openclaw.json before mirror init
    enrich_slots_from_gateway()

    # Initialize sub-modules with shared store
    history_sync.init(_history_store, broadcast_history_revision, adapter=get_default_adapter())
    mirror_mgr = mirror.init(_history_store)
    mirror.init_inbound()

    # Initialize route modules that need the store
    from backend.routes import history as routes_history
    from backend.routes import misc as routes_misc

    routes_history.init(_history_store)
    routes_misc.init(_history_store)

    # Set up per-bot locks
    history_sync._history_sync_locks.clear()
    from backend.ws.handler import _bot_send_locks

    _bot_send_locks.clear()
    for _bot_id in slot_ids():
        history_sync._history_sync_locks[_bot_id] = asyncio.Lock()
        _bot_send_locks[_bot_id] = asyncio.Lock()

    # Start mirror drain loop
    await mirror_mgr.start()

    # Start WAL checkpoint loop
    _wal_stop = asyncio.Event()
    _wal_task = asyncio.create_task(_wal_checkpoint_loop(_wal_stop))

    # Clean up orphaned tmux sessions from previous runs
    adapter = get_default_adapter()
    cleanup_fn = getattr(adapter, "cleanup_orphaned_tmux_sessions", None)
    if cleanup_fn:
        try:
            await cleanup_fn()
        except Exception as exc:
            logger.warning("tmux cleanup failed: {}", exc)

    # Inject WebSocket broadcast into the adapter (for SessionWatcher)
    set_ws_broadcast_fn = getattr(adapter, "set_ws_broadcast", None)
    if set_ws_broadcast_fn:
        from backend.runtime.state import broadcast_bot_event

        async def _ws_broadcast(bot_id: str, msg: dict):
            await broadcast_bot_event(msg)

        set_ws_broadcast_fn(_ws_broadcast)

    # Inject canonical store into the adapter (for watcher live persistence)
    set_canonical_store_fn = getattr(adapter, "set_canonical_store", None)
    if set_canonical_store_fn:
        set_canonical_store_fn(_history_store)

    # Control Plane registration (optional — no-op if not configured)
    from backend.control_plane_client import client as cp_client
    from backend.control_plane_client.config import is_cp_enabled

    if is_cp_enabled():
        adapter_info = get_active_adapter_info()
        await cp_client.register_host(capabilities=adapter_info)
        await cp_client.start_heartbeat()

    try:
        yield
    finally:
        # Stop Control Plane heartbeat
        await cp_client.stop_heartbeat()

        # Stop mirror drain loop
        await mirror_mgr.stop()

        # Stop WAL checkpoint loop
        _wal_stop.set()
        _wal_task.cancel()
        try:
            await _wal_task
        except asyncio.CancelledError:
            pass

        # Graceful DB shutdown
        logger.info("Graceful shutdown: checkpointing and closing DB...")
        try:
            _history_store._conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            _history_store.close()
            logger.info("DB closed cleanly")
        except Exception as e:
            logger.warning(f"DB close error: {e}")


async def _wal_checkpoint_loop(stop_evt: asyncio.Event):
    """Periodically checkpoint WAL and prune history."""
    while not stop_evt.is_set():
        try:
            await asyncio.sleep(300)  # every 5 minutes
            _history_store._conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
            logger.debug("WAL checkpoint (passive) completed")
            # History retention pruning
            if HISTORY_RETENTION_DAYS > 0 or HISTORY_MAX_MESSAGES_PER_BOT > 0:
                stats = _history_store.prune_history(
                    retention_days=HISTORY_RETENTION_DAYS,
                    max_per_bot=HISTORY_MAX_MESSAGES_PER_BOT,
                )
                total = stats["pruned_by_age"] + stats["pruned_by_count"]
                if total > 0:
                    logger.info(
                        f"History pruned: {stats['pruned_by_age']} by age, {stats['pruned_by_count']} by count limit"
                    )
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.warning(f"WAL checkpoint/prune error: {e}")


# Create the FastAPI application
app = FastAPI(title="TryVoice", lifespan=lifespan)


# Porcupine Web SDK requires SharedArrayBuffer, which needs COOP/COEP headers.
@app.middleware("http")
async def add_cross_origin_headers(request: Request, call_next):
    started = time.perf_counter()
    # Skip WebSocket upgrade requests
    if request.headers.get("upgrade", "").lower() == "websocket":
        return await call_next(request)
    if is_auth_enabled() and not is_public_http_path(request.url.path):
        if not is_request_authenticated(request):
            return unauthorized_json_response()
    try:
        response = await call_next(request)
    except Exception as e:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        record_exception(str(e))
        record_http(request.url.path, 500, elapsed_ms)
        raise
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    record_http(request.url.path, int(response.status_code), elapsed_ms)
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Embedder-Policy"] = "credentialless"
    return response


# Register all route modules
from backend.routes.auth import router as auth_router  # noqa: E402
from backend.routes.claude_sessions import _slot_router as claude_slot_router  # noqa: E402
from backend.routes.claude_sessions import router as claude_sessions_router  # noqa: E402
from backend.routes.history import router as history_router  # noqa: E402
from backend.routes.misc import router as misc_router  # noqa: E402
from backend.routes.settings import router as settings_router  # noqa: E402
from backend.routes.static import router as static_router  # noqa: E402
from backend.routes.tts import router as tts_router  # noqa: E402
from backend.routes.wakeword import router as wakeword_router  # noqa: E402
from backend.ws.handler import router as ws_router  # noqa: E402

app.include_router(tts_router)
app.include_router(history_router)
app.include_router(wakeword_router)
app.include_router(settings_router)
app.include_router(misc_router)
app.include_router(auth_router)
app.include_router(ws_router)
app.include_router(claude_sessions_router)
app.include_router(claude_slot_router)
# Static router last (has catch-all paths)
app.include_router(static_router)


def run_server(host: str = "0.0.0.0", port: int = 7860, verbose: int = 0, open_browser: bool = True):
    """Start the Voice Chat server."""
    # Ensure user data dirs exist
    USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
    (USER_DATA_DIR / "logs").mkdir(parents=True, exist_ok=True)

    logger.remove()
    stderr_level = "DEBUG" if verbose else "INFO"

    def _json_serializer(message):
        record = message.record
        import json as _json

        extra = record.get("extra", {})
        log_entry = {
            "ts": record["time"].isoformat(),
            "level": record["level"].name.lower().replace("warning", "warn"),
            "source": extra.get("source", "server"),
            "component": extra.get("component", f"{record['module']}.{record['function']}"),
            "message": record["message"],
        }
        # Optional context fields
        for key in ("session_id", "turn_id", "data", "conn_id", "client_id", "device_type"):
            if extra.get(key):
                log_entry[key] = extra[key]
        if record["exception"]:
            log_entry["error"] = str(record["exception"])
        return _json.dumps(log_entry, ensure_ascii=False, default=str) + "\n"

    _use_json = SERVER_LOG_FORMAT == "json"
    logger.add(
        sys.stderr,
        level=stderr_level,
        serialize=_use_json,
    )
    log_file_path = Path(SERVER_LOG_FILE).expanduser().resolve()
    log_file_path.parent.mkdir(parents=True, exist_ok=True)

    def _server_log_filter(record):
        """Suppress noisy DEBUG logs from canonicalize to prevent log rotation churn."""
        if record["level"].no <= 10:  # DEBUG
            name = record.get("name", "")
            if "canonicalize" in name:
                return False
        return True

    logger.add(
        str(log_file_path),
        level=SERVER_LOG_LEVEL,
        rotation=SERVER_LOG_ROTATION,
        retention=SERVER_LOG_RETENTION,
        enqueue=True,
        backtrace=False,
        diagnose=False,
        serialize=_use_json,
        filter=_server_log_filter,
    )

    # Client log sink (frontend logs received via WebSocket)
    client_log_path = log_file_path.parent / "client.log"
    logger.add(
        str(client_log_path),
        level="DEBUG",
        rotation=SERVER_LOG_ROTATION,
        retention=SERVER_LOG_RETENTION,
        enqueue=True,
        backtrace=False,
        diagnose=False,
        serialize=_use_json,
        filter=lambda record: record["extra"].get("source") == "client",
    )
    logger.info(f"Client log file: {client_log_path}")

    # Crash/recovery log sink — separate file, not affected by main log rotation
    crash_log_path = log_file_path.parent / "crash.log"
    logger.add(
        str(crash_log_path),
        level="WARNING",
        rotation="5 MB",
        retention="7 days",
        enqueue=True,
        backtrace=False,
        diagnose=False,
        serialize=_use_json,
        filter=lambda record: record["extra"].get("crash") is True,
    )
    logger.info(f"Crash log file: {crash_log_path}")

    logger.info(f"Config: {ENV_PATH}")
    logger.info(
        f"Server log file: {log_file_path} "
        f"(stderr={stderr_level}, file={SERVER_LOG_LEVEL}, "
        f"rotation={SERVER_LOG_ROTATION}, retention={SERVER_LOG_RETENTION})"
    )

    from backend.config.validate import validate_config

    issues = validate_config()
    for issue in issues:
        if issue["level"] == "error":
            logger.error(f"Config: {issue['key']} — {issue['message']}  Fix: {issue['fix']}")
        elif issue["level"] == "warning":
            logger.warning(f"Config: {issue['key']} — {issue['message']}  Fix: {issue['fix']}")
        else:
            logger.info(f"Config: {issue['key']} — {issue['message']}")

    from backend.adapter.registry import _router, get_active_adapter_id

    _adapter_id = get_active_adapter_id()
    _fallback_id = _router.fallback_id
    logger.info(f"Adapter: router (fallback={_fallback_id}, adapters={sorted(_router._adapters.keys())})")
    if "openclaw" in _router._adapters:
        try:
            from backend.config.openclaw import (
                GATEWAY_URL,
                SESSION_AGENT_ID,
                SESSION_HISTORY_TOOL_CANDIDATES,
                SESSION_NAMESPACE,
                SESSION_SCOPE,
                SESSION_SEND_TOOL_CANDIDATES,
            )

            logger.info(f"Gateway: {GATEWAY_URL}")
            logger.info(
                f"Session namespace: agent={SESSION_AGENT_ID}, namespace={SESSION_NAMESPACE}, scope={SESSION_SCOPE}"
            )
            logger.info(
                "Gateway session tools: "
                f"send={SESSION_SEND_TOOL_CANDIDATES[0]} "
                f"(aliases={SESSION_SEND_TOOL_CANDIDATES[1:]}) | "
                f"history={SESSION_HISTORY_TOOL_CANDIDATES[0]} "
                f"(aliases={SESSION_HISTORY_TOOL_CANDIDATES[1:]})"
            )
        except ImportError:
            logger.info("Adapter: openclaw (config not available)")
    if _fallback_id == "openai-compat":
        _llm_base = os.getenv("LLM_API_BASE_URL", "http://localhost:11434/v1")
        _llm_model = os.getenv("LLM_MODEL", "gpt-3.5-turbo")
        logger.info(f"Adapter: openai-compat (model={_llm_model}, base_url={_llm_base})")
    slot_list = list_slots()
    bot_list = ", ".join(f"{s['slotId']} ({s['name']})" for s in slot_list)
    logger.info(f"Slots: {bot_list}")
    for slot in slot_list:
        logger.info(f"Session key [{slot['slotId']}]: {slot['sessionKey']}")
    logger.info(f"Canonical DB: {CANONICAL_DB_PATH}")
    adapter_info = get_active_adapter_info()
    logger.info(
        "Adapter: "
        f"active={adapter_info.get('adapterId')} "
        f"(stream={adapter_info.get('supportsStream')}, "
        f"cancel={adapter_info.get('supportsCancel')}, "
        f"resume={adapter_info.get('supportsSessionResume')})"
    )
    logger.info(
        "Canonical Event Log v2: "
        f"dual_write={'on' if CANONICAL_EVENT_V2_DUAL_WRITE else 'off'}, "
        f"read_model={'v2' if CANONICAL_EVENT_V2_READ_ENABLED else 'v1'}"
    )
    logger.info(f"History sync: every {HISTORY_SYNC_INTERVAL_SECONDS}s, limit={HISTORY_SYNC_FETCH_LIMIT}")
    if HISTORY_RETENTION_DAYS > 0 or HISTORY_MAX_MESSAGES_PER_BOT > 0:
        logger.info(f"History retention: max_age={HISTORY_RETENTION_DAYS}d, max_per_bot={HISTORY_MAX_MESSAGES_PER_BOT}")
    else:
        logger.info("History retention: disabled (keep forever)")
    from backend.mirror import get_mirror_manager as _get_mm

    try:
        _mm_status = _get_mm().status()
        _mm_channels = _mm_status.get("channels", {})
        _ch_summary = ", ".join(
            f"{ch}({'on' if info.get('globalEnabled') else 'off'})" for ch, info in _mm_channels.items()
        )
        logger.info(f"Mirror: {_ch_summary or 'no channels'}")
    except RuntimeError:
        logger.info("Mirror: not initialized")
    from backend.voice.stt_registry import get_active_stt_info
    from backend.voice.tts_registry import get_active_tts_info

    _stt_info = get_active_stt_info()
    _tts_info = get_active_tts_info()
    logger.info(f"STT: {_stt_info['active']} (discovered: {_stt_info['discovered']})")
    logger.info(f"Browser STT key exposure: {'on' if EXPOSE_BROWSER_STT_KEY else 'off'}")
    logger.info(f"TTS: {_tts_info['active']} (discovered: {_tts_info['discovered']})")
    logger.info(f"Picovoice key exposure: {'on' if EXPOSE_PICOVOICE_KEY else 'off'}")
    logger.info(f"Access protection: {'on' if ACCESS_PASSWORD else 'off'}")

    cert = _USER_CERT_PATH
    key = _USER_KEY_PATH
    use_https = cert.exists() and key.exists()
    scheme = "https" if use_https else "http"
    # Use localhost for the browser URL (not 0.0.0.0)
    browser_url = f"{scheme}://localhost:{port}/"

    if open_browser:
        import threading
        import webbrowser

        def _open_browser():
            import time

            time.sleep(1.5)
            logger.info(f"Opening browser: {browser_url}")
            webbrowser.open(browser_url)

        threading.Thread(target=_open_browser, daemon=True).start()

    if use_https:
        logger.info("HTTPS enabled (self-signed cert)")
        uvicorn.run(app, host=host, port=port, ssl_certfile=str(cert), ssl_keyfile=str(key))
    else:
        logger.warning("No cert/key found, running plain HTTP")
        uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Voice Chat Server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "7860")))
    parser.add_argument("-v", "--verbose", action="count", default=0)
    args = parser.parse_args()
    run_server(host=args.host, port=args.port, verbose=args.verbose)
