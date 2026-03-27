"""Background task: generate LLM summaries for archived ephemeral bots."""

from __future__ import annotations

import asyncio

from loguru import logger

_running = False


async def generate_summaries_background() -> None:
    """Scan for unsummarized archived bots and generate summaries via LLM."""
    global _running
    if _running:
        logger.debug("Summary generation already running, skipping")
        return
    _running = True
    try:
        await _do_generate()
    except Exception as e:
        logger.error(f"Summary generation failed: {e}")
    finally:
        _running = False


async def _do_generate() -> None:
    from backend.adapter.registry import get_adapter
    from backend.app import get_config_store
    from backend.runtime.slot_registry import slot_ids

    config_store = get_config_store()

    # 1. Check LLM config
    llm_cfg = config_store.get_summary_llm_config()
    if not llm_cfg:
        logger.debug("Summary LLM not configured, skipping")
        return

    # 2. Find ephemeral adapter types and build config_id -> type mapping
    config_to_type: dict[str, str] = {}
    ephemeral_adapter_types: set[str] = set()
    for cfg in config_store.list_adapter_configs():
        cfg_id = cfg["id"]
        adapter_type = cfg["adapter_type"]
        config_to_type[cfg_id] = adapter_type
        if adapter_type not in ephemeral_adapter_types:
            try:
                adapter = get_adapter(adapter_type)
                if adapter.report_capabilities().ephemeral_sessions:
                    ephemeral_adapter_types.add(adapter_type)
            except (KeyError, Exception):
                ephemeral_adapter_types.add(adapter_type)  # default to ephemeral

    # 3. Get archived bot IDs for ephemeral adapters
    from backend.routes.history import _history_store

    if not _history_store:
        return
    rows = _history_store.history_by_adapter()
    active = set(slot_ids())
    archived_bots = []
    for r in rows:
        bid = r["bot_id"]
        if bid in active:
            continue
        cfg_id = r["adapter_config_id"] or ""
        atype = config_to_type.get(cfg_id, "unknown")
        is_ephemeral = atype in ephemeral_adapter_types or cfg_id == ""
        if is_ephemeral:
            archived_bots.append(bid)

    # 4. Filter to unattempted
    pending = config_store.get_unattempted_bot_ids(archived_bots)
    if not pending:
        logger.debug("No pending summaries to generate")
        return

    logger.info(f"Generating summaries for {len(pending)} archived bots")

    # 5. Generate with concurrency limit
    sem = asyncio.Semaphore(3)

    async def _summarize_one(bot_id: str) -> None:
        async with sem:
            try:
                summary = await _call_llm(bot_id, llm_cfg)
                config_store.set_bot_summary(bot_id, summary)
                if summary:
                    logger.info(f"Summary for {bot_id}: {summary}")
            except Exception as e:
                logger.warning(f"Summary generation failed for {bot_id}: {e}")
                config_store.set_bot_summary(bot_id, "")  # mark attempted

    await asyncio.gather(*[_summarize_one(bid) for bid in pending])


async def _call_llm(bot_id: str, llm_cfg: dict) -> str:
    """Call LLM API to summarize a bot's conversation."""
    import httpx

    from backend.routes.history import _history_store

    if not _history_store:
        return ""

    # Fetch latest messages (list_history uses _active_event_table() internally,
    # so it respects the v1/v2 read model toggle)
    history, _ = _history_store.list_history(bot_id, limit=20)
    if not history:
        return ""

    # Build conversation text
    lines = []
    for msg in history:
        role = msg.get("role", "")
        text = msg.get("text", "")
        if text:
            lines.append(f"{role}: {text}")
    conversation = "\n".join(lines)
    if len(conversation) > 2000:
        conversation = conversation[:2000] + "..."

    # Call LLM
    api_url = llm_cfg["api_url"].rstrip("/")
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {llm_cfg['api_key']}",
    }
    payload = {
        "model": llm_cfg["model"],
        "messages": [
            {
                "role": "system",
                "content": (
                    "Summarize this conversation in one short phrase "
                    "(≤10 Chinese characters or ≤6 English words). "
                    "Output ONLY the phrase."
                ),
            },
            {"role": "user", "content": conversation},
        ],
        "max_tokens": 50,
        "temperature": 0.3,
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(f"{api_url}/chat/completions", json=payload, headers=headers)
        resp.raise_for_status()
        result = resp.json()
        return result["choices"][0]["message"]["content"].strip()[:50]
