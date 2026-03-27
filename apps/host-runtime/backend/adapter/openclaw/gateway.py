"""OpenClaw gateway invocation logic (vendor-specific)."""

from __future__ import annotations

import asyncio
import json
import os
import re
import uuid
from pathlib import Path
from typing import Any

import aiohttp
from loguru import logger

from .message_utils import (
    _summarize_value,
    extract_history_messages,
    msg_content_text,
)


def _csv_tokens(raw: str) -> list[str]:
    out: list[str] = []
    for part in str(raw or "").split(","):
        token = part.strip()
        if token:
            out.append(token)
    return out


def _dedupe_keep_order(items: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for item in items:
        if item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out


# Read config from env vars directly
GATEWAY_URL = os.getenv("AGENT_GATEWAY_URL") or os.getenv("OPENCLAW_GATEWAY_URL") or "http://localhost:18789"
GATEWAY_TOKEN = os.getenv("AGENT_GATEWAY_TOKEN") or os.getenv("OPENCLAW_GATEWAY_TOKEN") or ""

SESSION_SEND_TOOL = os.getenv("OPENCLAW_TOOL_SESSIONS_SEND", "sessions_send").strip() or "sessions_send"
SESSION_HISTORY_TOOL = os.getenv("OPENCLAW_TOOL_SESSIONS_HISTORY", "sessions_history").strip() or "sessions_history"
SESSION_SEND_TOOL_CANDIDATES = _dedupe_keep_order(
    [SESSION_SEND_TOOL]
    + _csv_tokens(os.getenv("OPENCLAW_TOOL_SESSIONS_SEND_ALIASES", ""))
    + [
        "sessions_send",
        "sessions.send",
        "session_send",
        "session.send",
        "sessions/send",
    ]
)
SESSION_HISTORY_TOOL_CANDIDATES = _dedupe_keep_order(
    [SESSION_HISTORY_TOOL]
    + _csv_tokens(os.getenv("OPENCLAW_TOOL_SESSIONS_HISTORY_ALIASES", ""))
    + [
        "sessions_history",
        "sessions.history",
        "session_history",
        "session.history",
        "sessions/history",
    ]
)

SESSION_LIST_TOOL = os.getenv("OPENCLAW_TOOL_SESSIONS_LIST", "sessions_list").strip() or "sessions_list"
SESSION_LIST_TOOL_CANDIDATES = _dedupe_keep_order(
    [SESSION_LIST_TOOL]
    + _csv_tokens(os.getenv("OPENCLAW_TOOL_SESSIONS_LIST_ALIASES", ""))
    + [
        "sessions_list",
        "sessions.list",
        "session_list",
        "session.list",
        "sessions/list",
    ]
)


_SESSIONS_SEND_TOOL_SET = set(SESSION_SEND_TOOL_CANDIDATES)
_SESSIONS_HISTORY_TOOL_SET = set(SESSION_HISTORY_TOOL_CANDIDATES)
_SESSIONS_LIST_TOOL_SET = set(SESSION_LIST_TOOL_CANDIDATES)
_TOOL_ALIAS_CACHE: dict[str, str] = {}


def is_sessions_send_tool_name(tool: str) -> bool:
    return str(tool or "").strip() in _SESSIONS_SEND_TOOL_SET


def is_sessions_history_tool_name(tool: str) -> bool:
    return str(tool or "").strip() in _SESSIONS_HISTORY_TOOL_SET


def is_sessions_list_tool_name(tool: str) -> bool:
    return str(tool or "").strip() in _SESSIONS_LIST_TOOL_SET


def _logical_tool_key(tool: str) -> str:
    if is_sessions_send_tool_name(tool):
        return "sessions_send"
    if is_sessions_history_tool_name(tool):
        return "sessions_history"
    if is_sessions_list_tool_name(tool):
        return "sessions_list"
    return ""


def _tool_candidates(tool: str) -> list[str]:
    requested = str(tool or "").strip()
    logical = _logical_tool_key(requested)
    if logical == "sessions_send":
        candidates = list(SESSION_SEND_TOOL_CANDIDATES)
    elif logical == "sessions_history":
        candidates = list(SESSION_HISTORY_TOOL_CANDIDATES)
    elif logical == "sessions_list":
        candidates = list(SESSION_LIST_TOOL_CANDIDATES)
    else:
        return [requested]

    cached = _TOOL_ALIAS_CACHE.get(logical)
    if cached and cached in candidates:
        return [cached] + [c for c in candidates if c != cached]
    return candidates


def _is_tool_not_available_error(data: dict) -> bool:
    err = data.get("error")
    if isinstance(err, dict):
        err_type = str(err.get("type", "")).strip().lower()
        msg = str(err.get("message", "")).strip().lower()
        if err_type in {"not_found", "unknown_tool", "tool_not_available"}:
            return True
        if "tool not available" in msg or "unknown tool" in msg:
            return True
        return False
    msg = str(err or "").strip().lower()
    return "tool not available" in msg or "unknown tool" in msg


def _preview_text(text: str, max_len: int = 120) -> str:
    one_line = re.sub(r"\s+", " ", (text or "").strip())
    return one_line[:max_len]


def _summarize_gateway_args(tool: str, args: dict) -> dict:
    if is_sessions_send_tool_name(tool):
        return {
            "sessionKey": _summarize_value(args.get("sessionKey"), 180),
            "timeoutSeconds": _summarize_value(args.get("timeoutSeconds")),
            "messagePreview": _summarize_value(args.get("message"), 160),
        }
    if is_sessions_history_tool_name(tool):
        return {
            "sessionKey": _summarize_value(args.get("sessionKey"), 180),
            "limit": _summarize_value(args.get("limit")),
        }
    if tool == "message":
        return {
            "action": _summarize_value(args.get("action")),
            "channel": _summarize_value(args.get("channel")),
            "accountId": _summarize_value(args.get("accountId")),
            "target": _summarize_value(args.get("target")),
            "messagePreview": _summarize_value(args.get("message"), 160),
        }
    out = {}
    for key, value in list(args.items())[:12]:
        out[key] = _summarize_value(value, 120)
    return out


def _summarize_gateway_result(tool: str, data: dict) -> dict:
    if not isinstance(data, dict):
        return {
            "ok": False,
            "error": "",
            "rawType": type(data).__name__,
            "rawPreview": _preview_text(str(data), 160),
        }
    summary = {
        "ok": bool(data.get("ok")),
        "error": _preview_text(str(data.get("error", "")), 160),
    }
    if is_sessions_history_tool_name(tool):
        msgs = extract_history_messages(data)
        tail = []
        for m in msgs[-3:]:
            tail.append(
                {
                    "role": str(m.get("role", "")),
                    "ts": str(m.get("timestamp", "") or m.get("ts", "") or ""),
                    "text": _preview_text(msg_content_text(m), 90),
                }
            )
        summary["count"] = len(msgs)
        summary["tail"] = tail
        return summary
    if is_sessions_send_tool_name(tool):
        details = data.get("result", {}).get("details", {}) if isinstance(data.get("result"), dict) else {}
        reply = details.get("reply", "") if isinstance(details, dict) else ""
        summary["replyPreview"] = _preview_text(str(reply), 140)
        summary["status"] = _preview_text(str(details.get("status", "")), 32) if isinstance(details, dict) else ""
        return summary
    res = data.get("result")
    summary["result"] = _summarize_value(res, 160)
    return summary


def gateway_read_config() -> dict[str, Any]:
    """Read ~/.openclaw/openclaw.json and extract accounts, agents, and bindings.

    Path can be overridden via OPENCLAW_CONFIG_PATH (full file path) or
    OPENCLAW_HOME (directory containing openclaw.json).

    Returns {"accounts": [...], "agents": [...], "bindings": [...]}.
    Each account: {accountId, name, channel, enabled}.
    Each agent:   {id, name, default}.
    Each binding: {agentId, match: {channel?, accountId?}}.
    """
    config_path = os.getenv("OPENCLAW_CONFIG_PATH")
    if not config_path:
        home = os.getenv("OPENCLAW_HOME") or str(Path.home() / ".openclaw")
        config_path = str(Path(home) / "openclaw.json")

    result: dict[str, Any] = {"accounts": [], "agents": [], "bindings": []}

    fp = Path(config_path)
    if not fp.is_file():
        logger.debug(f"gateway_read_config: {config_path} not found, returning empty")
        return result

    try:
        data = json.loads(fp.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning(f"gateway_read_config: failed to parse {config_path}: {e}")
        return result

    # Extract channel accounts
    channels = data.get("channels") or {}
    for channel_id, channel_conf in channels.items():
        if not isinstance(channel_conf, dict):
            continue
        accounts = channel_conf.get("accounts") or {}
        if not accounts and channel_conf.get("botToken"):
            # Compat: single-bot mode — botToken at channel level, no accounts layer
            accounts = {
                channel_id: {
                    "botToken": channel_conf["botToken"],
                    "name": channel_conf.get("name") or channel_id,
                    "enabled": channel_conf.get("enabled", True),
                }
            }
        for account_id, account_conf in accounts.items():
            if not isinstance(account_conf, dict):
                continue
            result["accounts"].append(
                {
                    "accountId": account_id,
                    "name": account_conf.get("name") or account_id,
                    "channel": channel_id,
                    "enabled": bool(account_conf.get("enabled", True)),
                    "botToken": str(account_conf.get("botToken") or ""),
                }
            )

    # Extract agents
    agents_conf = data.get("agents") or {}
    agent_list = agents_conf.get("list") or []
    if not agent_list and agents_conf.get("defaults"):
        # Compat: single-agent mode — no list, infer from defaults
        defaults = agents_conf["defaults"]
        agent_id = defaults.get("agentId") or defaults.get("agent") or "main"
        agent_list = [{"id": agent_id, "name": agent_id, "default": True}]
    for agent in agent_list:
        if not isinstance(agent, dict):
            continue
        result["agents"].append(
            {
                "id": agent.get("id", ""),
                "name": agent.get("name") or agent.get("id", ""),
                "default": bool(agent.get("default", False)),
            }
        )

    # Extract bindings
    bindings = data.get("bindings") or []
    for binding in bindings:
        if not isinstance(binding, dict):
            continue
        result["bindings"].append(
            {
                "agentId": binding.get("agentId", ""),
                "match": binding.get("match") or {},
            }
        )

    logger.info(
        f"gateway_read_config: {len(result['accounts'])} account(s), "
        f"{len(result['agents'])} agent(s), {len(result['bindings'])} binding(s)"
    )
    return result


async def gateway_list_agents(session: aiohttp.ClientSession) -> list[dict[str, Any]]:
    """Query the gateway for active sessions via the sessions_list tool.

    Returns a list of session dicts, or [] if the tool is unavailable.
    Each session dict contains keys like 'key', 'displayName', 'model', etc.
    """
    data = await gateway_invoke("sessions_list", {}, session)

    if not data.get("ok"):
        error = data.get("error", "")
        if _is_tool_not_available_error(data):
            logger.info("gateway_list_agents: sessions_list tool not available")
        else:
            logger.warning(f"gateway_list_agents: error: {error}")
        return []

    result = data.get("result", {})
    details = result.get("details", {}) if isinstance(result, dict) else {}
    sessions = details.get("sessions", []) if isinstance(details, dict) else []
    if not isinstance(sessions, list):
        return []
    logger.info(f"gateway_list_agents: discovered {len(sessions)} session(s)")
    return sessions


async def gateway_invoke(tool: str, args: dict, session: aiohttp.ClientSession) -> dict:
    url = f"{GATEWAY_URL}/tools/invoke"
    headers = {
        "Authorization": f"Bearer {GATEWAY_TOKEN}",
        "Content-Type": "application/json",
    }

    invoke_session_key = None
    if isinstance(args, dict):
        sk = args.get("sessionKey")
        if isinstance(sk, str) and sk.strip():
            invoke_session_key = sk.strip()

    requested_tool = str(tool or "").strip()
    if not requested_tool:
        return {"ok": False, "error": "empty tool name"}

    candidates = _tool_candidates(requested_tool)
    logical_tool = _logical_tool_key(requested_tool)
    last_result: dict = {"ok": False, "error": f"tool invoke failed: {requested_tool}"}

    for index, candidate in enumerate(candidates):
        body: dict[str, Any] = {"tool": candidate, "args": args}
        if invoke_session_key:
            body["sessionKey"] = invoke_session_key

        _is_history_fetch = is_sessions_history_tool_name(candidate)
        if not _is_history_fetch:
            logger.debug(
                f"Gateway -> {candidate} (req={requested_tool}): {_summarize_gateway_args(candidate, args)}"
                + (f" | invoke.sessionKey={invoke_session_key}" if invoke_session_key else "")
            )
        try:
            async with session.post(url, headers=headers, json=body) as resp:
                try:
                    data = await resp.json()
                except Exception:
                    raw = await resp.text()
                    logger.error(f"Gateway {candidate} invalid JSON {resp.status}: {raw[:240]}")
                    return {"ok": False, "error": f"invalid gateway JSON ({candidate})"}

                last_result = data if isinstance(data, dict) else {"ok": False, "error": str(data)}
                if not _is_history_fetch:
                    logger.debug(
                        f"Gateway <- {candidate} [{resp.status}]: {_summarize_gateway_result(candidate, last_result)}"
                    )

                if resp.status == 200 and bool(last_result.get("ok")):
                    if logical_tool:
                        _TOOL_ALIAS_CACHE[logical_tool] = candidate
                    if candidate != requested_tool:
                        logger.info(f"Gateway tool remap: {requested_tool} -> {candidate}")
                    return last_result

                is_not_found = resp.status in {400, 404} and _is_tool_not_available_error(last_result)
                if is_not_found:
                    if index + 1 < len(candidates):
                        logger.warning(
                            f"Gateway tool unavailable: {candidate} (requested={requested_tool}), "
                            f"retrying alias {index + 2}/{len(candidates)}"
                        )
                        continue
                    logger.error(f"Gateway {candidate} unavailable after alias retries: {last_result}")
                    break

                if resp.status != 200:
                    logger.error(f"Gateway {candidate} error {resp.status}: {last_result}")
                return last_result
        except aiohttp.ClientError as e:
            logger.error(f"Gateway unreachable ({candidate}): {e}")
            return {"ok": False, "error": f"Gateway unreachable: {e}"}

    if _is_tool_not_available_error(last_result):
        hint = (
            "Tool not available. Check OPENCLAW_TOOL_SESSIONS_SEND/"
            "OPENCLAW_TOOL_SESSIONS_HISTORY mapping. For OpenClaw gateway, "
            "ensure tools.agentToAgent.enabled=true and "
            "gateway.tools.allow includes sessions_send "
            "(for example: openclaw config set gateway.tools.allow "
            "'[\"sessions_send\"]' && openclaw daemon restart)."
        )
        err = last_result.get("error")
        if isinstance(err, dict):
            if "hint" not in err:
                err["hint"] = hint
        else:
            merged = f"{str(err).strip()} | {hint}".strip(" |")
            last_result["error"] = merged
    return last_result


async def gateway_abort_chat(session_key: str, *, run_id: str | None = None, timeout: float = 5.0) -> dict:
    """Send chat.abort RPC to the OpenClaw gateway via WebSocket.

    The gateway exposes chat.abort only as a WebSocket RPC method,
    not through the HTTP /tools/invoke endpoint.
    """
    ws_url = GATEWAY_URL.replace("http://", "ws://").replace("https://", "wss://")
    ws_url = f"{ws_url}/ws"

    req_id = f"abort-{uuid.uuid4().hex[:8]}"
    params: dict[str, Any] = {"sessionKey": session_key}
    if run_id:
        params["runId"] = run_id

    rpc_msg = json.dumps({"type": "req", "id": req_id, "method": "chat.abort", "params": params})

    try:
        async with aiohttp.ClientSession() as http:
            headers: dict[str, str] = {}
            if GATEWAY_TOKEN:
                headers["Authorization"] = f"Bearer {GATEWAY_TOKEN}"
            async with http.ws_connect(ws_url, headers=headers, timeout=timeout) as ws:
                await ws.send_str(rpc_msg)

                # Wait for matching response
                deadline = asyncio.get_event_loop().time() + timeout
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        try:
                            data = json.loads(msg.data)
                        except json.JSONDecodeError:
                            continue
                        if data.get("id") == req_id and data.get("type") == "res":
                            if data.get("ok"):
                                return data.get("payload", {})
                            return {"ok": False, "error": data.get("error")}
                    elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                        break
                    if asyncio.get_event_loop().time() > deadline:
                        break

        return {"ok": False, "error": "timeout waiting for chat.abort response"}
    except Exception as exc:
        logger.warning(f"gateway_abort_chat WebSocket error: {exc}")
        return {"ok": False, "error": str(exc)}
