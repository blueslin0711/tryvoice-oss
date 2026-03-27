"""
CLI entry point for TryVoice.

Usage:
    tryvoice                  # Start server and open browser (configure via web UI)
    tryvoice --no-browser     # Start server without opening browser
    tryvoice --setup          # Force CLI setup wizard (power-user escape hatch)
    tryvoice --setup adapter  # Reconfigure only the adapter section (CLI)
    tryvoice --check          # Run diagnostic checks
    tryvoice --host 0.0.0.0 --port 7860
"""

from __future__ import annotations

import argparse
import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path

# ── ANSI color helpers ─────────────────────────────────────────────────────

_GREEN = "\033[32m"
_RED = "\033[31m"
_YELLOW = "\033[33m"
_BOLD = "\033[1m"
_RESET = "\033[0m"


def _pass(label: str, detail: str = "") -> bool:
    suffix = f"  {detail}" if detail else ""
    print(f"  {_GREEN}PASS{_RESET}  {label}{suffix}")
    return True


def _fail(label: str, detail: str = "") -> bool:
    suffix = f"  {detail}" if detail else ""
    print(f"  {_RED}FAIL{_RESET}  {label}{suffix}")
    return False


def _warn(label: str, detail: str = ""):
    suffix = f"  {detail}" if detail else ""
    print(f"  {_YELLOW}WARN{_RESET}  {label}{suffix}")


# ── .env file parser / writer ──────────────────────────────────────────────


def _parse_env_file(path: Path) -> dict[str, str]:
    """Parse a .env file into a dict.  Handles comments, empty lines,
    and values optionally wrapped in single or double quotes."""
    result: dict[str, str] = {}
    if not path.exists():
        return result
    for line in path.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        key = key.strip()
        value = value.strip()
        # Strip surrounding quotes
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        result[key] = value
    return result


def _write_env_file(path: Path, data: dict[str, str]):
    """Write a dict as a .env file with a header comment."""
    lines = ["# TryVoice configuration"]
    for key, value in data.items():
        # Quote values that contain spaces or special chars
        if " " in value or "#" in value or ";" in value:
            # Use double quotes, escaping any inner double quotes
            escaped = value.replace('"', '\\"')
            lines.append(f'{key}="{escaped}"')
        else:
            lines.append(f"{key}={value}")
    path.write_text("\n".join(lines) + "\n")


def _merge_env(existing: dict[str, str], new_values: dict[str, str]) -> dict[str, str]:
    """Merge new values into existing env.  New values override existing ones.
    Keys not present in new_values are preserved from existing."""
    merged = dict(existing)
    merged.update(new_values)
    return merged


# ── Adapter discovery ──────────────────────────────────────────────────────


def _discover_adapter_choices() -> list[tuple[str, str]]:
    """Return list of (adapter_id, description) for available adapters."""
    from backend.adapter.registry import list_adapters

    _descriptions = {
        "claude-code": "Claude Code",
        "openclaw": "OpenClaw",
        "openai-compat": "OpenAI-compatible (DeepSeek, Ollama, OpenAI, etc.)",
        "anthropic": "Anthropic Claude API",
        "codex-cli": "OpenAI Codex CLI",
        "gemini-cli": "Google Gemini CLI",
    }
    choices: list[tuple[str, str]] = []
    for name in list_adapters():
        desc = _descriptions.get(name, name)
        choices.append((name, desc))
    return choices


# ── Known LLM presets ──────────────────────────────────────────────────────

LLM_PRESETS = {
    "creative": "Higher temperature (0.9), good for brainstorming and storytelling",
    "precise": "Lower temperature (0.3), good for factual Q&A and coding",
    "balanced": "Medium temperature (0.7), general-purpose default",
    "concise": "Short answers, max_tokens=256, temperature=0.5",
}


# ── Schema-driven config field prompt ──────────────────────────────────────


def _prompt_config_field(field, existing):
    """Prompt user for a single config field value.
    Uses existing[field.name] as default if present, else field.default."""

    effective_default = existing.get(field.name, field.default) or ""

    if field.field_type == "select" and field.options:
        print(f"    Options for {field.label}:")
        for i, opt in enumerate(field.options, 1):
            marker = " (default)" if opt == effective_default else ""
            print(f"      {i}. {opt}{marker}")
        raw = input(f"    {field.label} [1-{len(field.options)}]: ").strip()
        try:
            idx = int(raw) - 1
            if 0 <= idx < len(field.options):
                return field.options[idx]
        except (ValueError, IndexError):
            pass
        return effective_default or (field.options[0] if field.options else "")

    if field.field_type == "boolean":
        raw = input(f"    {field.label} [y/N]: ").strip().lower()
        return "true" if raw in ("y", "yes") else "false"

    label = field.label
    if field.description:
        label += f" ({field.description})"

    if effective_default:
        raw = input(f"    {label} [{effective_default}]: ").strip()
        return raw or effective_default
    else:
        suffix = " (optional, Enter to skip)" if not field.required else ""
        raw = input(f"    {label}{suffix}: ").strip()
        return raw or None


# ── Load adapter class from entry_points ──────────────────────────────────


def _load_adapter_class(adapter_id):
    """Load adapter CLASS (not instance) by name. Returns None if not found."""
    from backend.adapter.registry import get_adapter

    try:
        adapter = get_adapter(adapter_id)
        return type(adapter)
    except KeyError:
        return None


# ── Input helper with default from existing env ───────────────────────────


def _prompt(label: str, default: str = "", existing: dict[str, str] | None = None, env_key: str = "") -> str:
    """Prompt user for input.  If existing env has a value for env_key, use it
    as the default (shown in brackets).  Returns the user's input or the default."""
    effective_default = default
    if existing and env_key and env_key in existing:
        effective_default = existing[env_key]

    if effective_default:
        raw = input(f"  {label} [{effective_default}]: ").strip()
        return raw or effective_default
    else:
        raw = input(f"  {label}: ").strip()
        return raw


# ── Setup wizard sections ─────────────────────────────────────────────────


def _setup_adapter(existing: dict[str, str]) -> dict[str, str]:
    """Run adapter selection and configuration.  Returns new env key/values."""
    result: dict[str, str] = {}

    adapter_choices = _discover_adapter_choices()
    print("  Available adapters:")
    for i, (aid, desc) in enumerate(adapter_choices, 1):
        print(f"    {i}. {desc}")
    print()

    # Determine default selection from existing config
    current_adapter = existing.get("TRYVOICE_ACTIVE_ADAPTER", "")
    default_idx = 1
    for i, (aid, _) in enumerate(adapter_choices, 1):
        if aid == current_adapter:
            default_idx = i
            break

    adapter_id = "claude-code"
    if len(adapter_choices) > 1:
        choice_str = input(f"  Choose adapter [1-{len(adapter_choices)}, default={default_idx}]: ").strip()
        try:
            choice_idx = int(choice_str) - 1
            if 0 <= choice_idx < len(adapter_choices):
                adapter_id = adapter_choices[choice_idx][0]
            else:
                adapter_id = adapter_choices[default_idx - 1][0]
        except (ValueError, IndexError):
            adapter_id = adapter_choices[default_idx - 1][0]
    print(f"  -> Selected adapter: {adapter_id}")
    print()

    result["TRYVOICE_ACTIVE_ADAPTER"] = adapter_id

    # ── Schema-driven configuration (preferred) ──
    adapter_cls = _load_adapter_class(adapter_id)
    if adapter_cls and hasattr(adapter_cls, "config_schema"):
        schema = adapter_cls.config_schema()
        if schema:
            print(f"\n  Configure {adapter_id}:")
            for group in ["connection", "model", "advanced"]:
                fields = [f for f in schema if f.group == group]
                if not fields:
                    continue
                if group == "advanced":
                    print("\n  Advanced settings (Enter to keep defaults):")
                for field in fields:
                    value = _prompt_config_field(field, existing)
                    if value is not None:
                        result[field.name] = value
            print()
            return result

    # ── Legacy fallback for adapters without config_schema ──
    if adapter_id == "openai-compat":
        result["LLM_API_BASE_URL"] = _prompt(
            "LLM API Base URL",
            "http://localhost:11434/v1",
            existing,
            "LLM_API_BASE_URL",
        )
        api_key = _prompt(
            "LLM API Key (optional, press Enter to skip)",
            "",
            existing,
            "LLM_API_KEY",
        )
        if api_key:
            result["LLM_API_KEY"] = api_key

        result["LLM_MODEL"] = _prompt(
            "Model name",
            "gpt-3.5-turbo",
            existing,
            "LLM_MODEL",
        )
        result["LLM_SYSTEM_PROMPT"] = _prompt(
            "System prompt",
            "You are a helpful assistant.",
            existing,
            "LLM_SYSTEM_PROMPT",
        )

        # ── Advanced LLM configuration ──
        print()
        print("  Advanced LLM settings (press Enter to keep defaults):")

        max_history = _prompt(
            "LLM_MAX_HISTORY (max history messages per session)",
            "50",
            existing,
            "LLM_MAX_HISTORY",
        )
        result["LLM_MAX_HISTORY"] = max_history

        temperature = _prompt(
            "LLM_TEMPERATURE (optional, Enter for model default)",
            "",
            existing,
            "LLM_TEMPERATURE",
        )
        if temperature:
            result["LLM_TEMPERATURE"] = temperature

        max_tokens = _prompt(
            "LLM_MAX_TOKENS (optional, Enter for model default)",
            "",
            existing,
            "LLM_MAX_TOKENS",
        )
        if max_tokens:
            result["LLM_MAX_TOKENS"] = max_tokens

        # Show available presets
        print()
        print("  Available LLM presets:")
        for name, desc in LLM_PRESETS.items():
            print(f"    - {name}: {desc}")
        preset = _prompt(
            "LLM_PRESET (optional, Enter to skip)",
            "",
            existing,
            "LLM_PRESET",
        )
        if preset:
            result["LLM_PRESET"] = preset

    elif adapter_id == "openclaw":
        result["AGENT_GATEWAY_URL"] = _prompt(
            "OpenClaw Gateway URL",
            "http://localhost:18789",
            existing,
            "AGENT_GATEWAY_URL",
        )
        result["AGENT_GATEWAY_TOKEN"] = _prompt(
            "OpenClaw Gateway Token",
            "",
            existing,
            "AGENT_GATEWAY_TOKEN",
        )

    return result


def _setup_stt(existing: dict[str, str]) -> dict[str, str]:
    """Run STT configuration.  Returns new env key/values."""
    result: dict[str, str] = {}

    print()
    print("  Speech-to-text: Install local Whisper model (~140MB) for")
    print("  offline transcription? No API key required.")
    print()
    print("  (You can also configure cloud API keys later in the browser")
    print("   for lower-latency transcription.)")
    print()

    existing_provider = existing.get("TRYVOICE_STT_PROVIDER", "")
    default = "Y" if existing_provider != "groq" else "N"
    choice = input(f"  Install local Whisper? [{'Y/n' if default == 'Y' else 'y/N'}]: ").strip().lower()
    if not choice:
        choice = default.lower()

    if choice in ("y", "yes"):
        print()
        print("  Installing faster-whisper...")
        try:
            subprocess.run(
                [sys.executable, "-m", "pip", "install", "faster-whisper>=1.0"],
                check=True,
                capture_output=True,
            )
            print(f"  {_GREEN}faster-whisper installed.{_RESET}")
        except subprocess.CalledProcessError as exc:
            print(f"  {_RED}Failed to install faster-whisper:{_RESET} {exc}")
            print("  You can install manually later: pip install faster-whisper")
            print("  Falling back to Groq (configure API key in browser).")
            result["TRYVOICE_STT_PROVIDER"] = "groq"
            return result

        print("  Downloading Whisper base model (first-time only)...")
        try:
            subprocess.run(
                [
                    sys.executable,
                    "-c",
                    "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8')",
                ],
                check=True,
                capture_output=True,
            )
            print(f"  {_GREEN}Whisper base model ready.{_RESET}")
        except subprocess.CalledProcessError as exc:
            print(f"  {_YELLOW}Model download failed:{_RESET} {exc}")
            print("  The model will be downloaded automatically on first use.")

        result["TRYVOICE_STT_PROVIDER"] = "whisper"
    else:
        result["TRYVOICE_STT_PROVIDER"] = "groq"
        print()
        print("  -> Using Groq cloud STT. Configure your Groq API Key in the")
        print("     browser Settings panel after startup.")
    return result


def _setup_wakeword(existing: dict[str, str]) -> dict[str, str]:
    """Run wake word configuration.  Returns new env key/values."""
    result: dict[str, str] = {}
    print()
    print("  Wake word: OpenWakeWord (6 built-in keywords) is pre-configured.")
    print("  Picovoice (more accurate) requires an API key.")
    pv_key = _prompt(
        "Picovoice Access Key (optional, press Enter to skip)",
        "",
        existing,
        "PICOVOICE_ACCESS_KEY",
    )
    if pv_key:
        result["PICOVOICE_ACCESS_KEY"] = pv_key
    return result


def _setup_tts(existing: dict[str, str]) -> dict[str, str]:
    """Run TTS configuration.  Returns new env key/values."""
    result: dict[str, str] = {}
    result["EDGE_TTS_VOICE"] = _prompt(
        "Edge TTS Voice",
        "zh-CN-XiaoxiaoNeural",
        existing,
        "EDGE_TTS_VOICE",
    )
    return result


def _setup_server(existing: dict[str, str]) -> dict[str, str]:
    """Run server/port/password configuration.  Returns new env key/values."""
    result: dict[str, str] = {}
    access_password = _prompt(
        "Access password (optional, usually not needed for personal local use)",
        "",
        existing,
        "TRYVOICE_ACCESS_PASSWORD",
    )
    if access_password:
        result["TRYVOICE_ACCESS_PASSWORD"] = access_password
    result["PORT"] = _prompt("Server port", "7860", existing, "PORT")
    return result


# ── Full / partial setup wizard ───────────────────────────────────────────

_SETUP_SECTIONS = {
    "adapter": _setup_adapter,
    "stt": _setup_stt,
    "tts": _setup_tts,
    "wakeword": _setup_wakeword,
    "server": _setup_server,
}

_FULL_SECTION_ORDER = ["adapter", "stt", "wakeword", "tts", "server"]


def _first_run_setup(section: str | None = None):
    """Interactive setup wizard.

    If *section* is None, run the full wizard.
    If *section* is one of adapter/stt/tts/wakeword/server, run only that part.

    In all cases, existing .env values are read first and used as defaults.
    After the wizard, new values are merged into the existing .env (preserving
    keys the user didn't change).
    """
    from backend.paths import (
        CERT_PATH,
        DEFAULT_SETTINGS_PATH,
        ENV_PATH,
        KEY_PATH,
        SETTINGS_PATH,
        USER_DATA_DIR,
    )

    # Read existing env for merge-mode defaults
    existing = _parse_env_file(ENV_PATH)

    is_first_run = not ENV_PATH.exists()

    print()
    print("=" * 56)
    if section:
        print(f"  TryVoice Setup  [{section}]")
    elif is_first_run:
        print("  Welcome to TryVoice!  Let's set things up.")
    else:
        print("  TryVoice Setup  (re-configuration)")
    print("=" * 56)
    print()
    print(f"  Config will be saved to: {ENV_PATH}")
    if existing and not section:
        print("  (Existing .env found -- values will be used as defaults)")
    print()

    USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
    (USER_DATA_DIR / "logs").mkdir(parents=True, exist_ok=True)

    # Determine which sections to run
    if section:
        if section not in _SETUP_SECTIONS:
            print(f"  Error: unknown setup section '{section}'.")
            print(f"  Available sections: {', '.join(_SETUP_SECTIONS.keys())}")
            sys.exit(1)
        sections_to_run = [section]
    else:
        sections_to_run = list(_FULL_SECTION_ORDER)

    # Collect new values from each section
    new_values: dict[str, str] = {}
    for sec in sections_to_run:
        fn = _SETUP_SECTIONS[sec]
        new_values.update(fn(existing))

    # Merge new values into existing env and write
    merged = _merge_env(existing, new_values)
    _write_env_file(ENV_PATH, merged)
    print(f"\n  Config saved to {ENV_PATH}")

    # Copy default settings if not present (only on full wizard)
    if not section:
        if not SETTINGS_PATH.exists() and DEFAULT_SETTINGS_PATH.exists():
            shutil.copy2(DEFAULT_SETTINGS_PATH, SETTINGS_PATH)
            print(f"  Default settings copied to {SETTINGS_PATH}")

        # Optional self-signed cert
        gen_cert = input("\n  Generate self-signed HTTPS cert? (recommended) [y/N]: ").strip().lower()
        if gen_cert in ("y", "yes"):
            _generate_self_signed_cert(CERT_PATH, KEY_PATH)

    print("\n  Setup complete! Starting server...\n")


def _generate_self_signed_cert(cert_path: Path, key_path: Path):
    """Generate self-signed cert using openssl."""
    try:
        subprocess.run(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-keyout",
                str(key_path),
                "-out",
                str(cert_path),
                "-days",
                "365",
                "-nodes",
                "-subj",
                "/CN=localhost",
            ],
            check=True,
            capture_output=True,
        )
        key_path.chmod(0o600)
        print(f"  Cert: {cert_path}")
        print(f"  Key:  {key_path}")
    except FileNotFoundError:
        print("  Warning: openssl not found, skipping cert generation.")
        print("  You can generate a cert later with:")
        print(f"    openssl req -x509 -newkey rsa:2048 -keyout {key_path} -out {cert_path} -days 365 -nodes")
    except subprocess.CalledProcessError as e:
        print(f"  Warning: cert generation failed: {e.stderr.decode()[:200]}")


# ── --check diagnostic command ─────────────────────────────────────────────


def _run_check():
    """Run diagnostic checks against the current .env configuration."""
    from backend.paths import ENV_PATH

    print()
    print("=" * 56)
    print("  TryVoice Diagnostics")
    print("=" * 56)
    print()

    all_ok = True

    # 1. Load .env
    if ENV_PATH.exists():
        _pass(".env file", str(ENV_PATH))
        env = _parse_env_file(ENV_PATH)
    else:
        _fail(".env file", f"not found at {ENV_PATH}")
        print("\n  Run 'tryvoice --setup' to create configuration.\n")
        sys.exit(1)

    adapter_id = env.get("TRYVOICE_ACTIVE_ADAPTER", "claude-code")
    _pass("Active adapter", adapter_id)

    # 2. Check adapter is installed and loadable
    print()
    try:
        from backend.adapter.registry import get_adapter

        get_adapter(adapter_id)
        _pass("Adapter loadable", adapter_id)
    except KeyError:
        all_ok = _fail("Adapter installed", f"'{adapter_id}' not found in registry") and all_ok
    except Exception as exc:
        all_ok = False
        _fail("Adapter loadable", f"import error: {exc}")

    # 3. Adapter-specific connectivity test
    print()
    if adapter_id == "openai-compat":
        base_url = env.get("LLM_API_BASE_URL", "http://localhost:11434/v1").rstrip("/")
        api_key = env.get("LLM_API_KEY", "")
        model = env.get("LLM_MODEL", "gpt-3.5-turbo")
        url = f"{base_url}/chat/completions"

        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        payload = {
            "model": model,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 1,
        }

        try:
            import httpx

            with httpx.Client(timeout=10) as client:
                resp = client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
            _pass("LLM API connectivity", f"{base_url}  (model={model})")
        except Exception as exc:
            all_ok = False
            _fail("LLM API connectivity", f"{base_url}  -> {exc}")

    elif adapter_id == "openclaw":
        gateway_url = env.get("AGENT_GATEWAY_URL", "http://localhost:18789").rstrip("/")
        try:
            import httpx

            with httpx.Client(timeout=10) as client:
                resp = client.get(gateway_url)
                # Any response (even 4xx) means the server is reachable
                _pass("Gateway connectivity", f"{gateway_url}  (HTTP {resp.status_code})")
        except Exception as exc:
            all_ok = False
            _fail("Gateway connectivity", f"{gateway_url}  -> {exc}")

    # 4. STT/TTS provider status
    print()
    try:
        from backend.voice.stt_registry import get_active_stt_info

        stt_info = get_active_stt_info()
        _pass("STT provider", f"{stt_info['active']} (discovered: {stt_info['discovered']})")
    except Exception as exc:
        all_ok = False
        _fail("STT provider", str(exc))

    try:
        from backend.voice.tts_registry import get_active_tts_info

        tts_info = get_active_tts_info()
        _pass("TTS provider", f"{tts_info['active']} (discovered: {tts_info['discovered']})")
    except Exception as exc:
        all_ok = False
        _fail("TTS provider", str(exc))

    print()
    groq_key = env.get("GROQ_API_KEY", "")
    if groq_key:
        _pass("Groq API key", "set (server-side STT enabled)")
    else:
        _warn("Groq API key", "not set (will use browser Web Speech API)")

    # 5. Port availability
    print()
    port = int(env.get("PORT", "7860"))
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("0.0.0.0", port))
        sock.close()
        _pass("Port available", f":{port}")
    except OSError as exc:
        all_ok = False
        _fail("Port available", f":{port}  -> {exc}")

    print()
    if all_ok:
        print(f"  {_GREEN}{_BOLD}All checks passed.{_RESET}")
    else:
        print(f"  {_RED}{_BOLD}Some checks failed.{_RESET}")
    print()

    sys.exit(0 if all_ok else 1)


# ── Whisper install prompt ────────────────────────────────────────────────


def _maybe_offer_whisper_install() -> None:
    """If no STT backend is available, offer to install local Whisper."""
    # Skip if Groq API key is configured
    groq_key = os.getenv("GROQ_API_KEY", "").strip()
    if groq_key:
        return

    # Skip if faster-whisper is already installed
    try:
        import faster_whisper  # noqa: F401

        return
    except ImportError:
        pass

    # No STT available — ask user
    print()
    print(f"  {_YELLOW}No speech-to-text backend detected.{_RESET}")
    print("  Voice input requires either a Groq API key (configurable in browser)")
    print("  or local Whisper (runs on-device, no API key needed).")
    print()
    try:
        answer = input(f"  Install local Whisper now? (~1 GB download) [{_BOLD}y{_RESET}/n]: ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print()
        return

    if answer in ("y", "yes", ""):
        print()
        print(f"  {_BOLD}Installing faster-whisper...{_RESET}")
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "faster-whisper>=1.0"],
                stdout=sys.stdout,
                stderr=sys.stderr,
            )
            print(f"\n  {_GREEN}Local Whisper installed successfully.{_RESET}\n")
        except subprocess.CalledProcessError:
            print(f"\n  {_RED}Installation failed.{_RESET} You can install manually: pip install faster-whisper\n")
    else:
        print(
            "\n  Skipped. You can configure a Groq API key in the browser Setup Wizard,"
            "\n  or install later: pip install faster-whisper\n"
        )


# ── Main entry point ──────────────────────────────────────────────────────


def main():
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        prog="tryvoice",
        description="TryVoice",
    )
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=None, help="Server port (default: from .env or 7860)")
    parser.add_argument("-v", "--verbose", action="count", default=0, help="Increase log verbosity")
    parser.add_argument(
        "--setup",
        nargs="?",
        const="__full__",
        default=None,
        metavar="SECTION",
        help=(
            "Re-run setup wizard. Optional section: adapter, stt, tts, wakeword, server. If omitted, runs full wizard."
        ),
    )
    parser.add_argument("--check", action="store_true", help="Run diagnostic checks and exit")
    parser.add_argument("--no-browser", action="store_true", help="Don't auto-open browser on startup")
    parser.add_argument("--version", action="store_true", help="Show version and exit")
    args = parser.parse_args()

    if args.version:
        from backend import __version__

        print(f"TryVoice {__version__}")
        return

    # --check: run diagnostics and exit
    if args.check:
        _run_check()
        return  # _run_check calls sys.exit, but just in case

    # Import paths here (after args parsed) to avoid loading config too early

    # Explicit --setup: run CLI wizard and exit (power-user escape hatch)
    if args.setup is not None:
        section = None if args.setup == "__full__" else args.setup
        _first_run_setup(section=section)

    # Offer to install local Whisper STT if no STT backend is available
    _maybe_offer_whisper_install()

    # Import server (triggers config loading from .env)
    from backend.app import run_server

    port = args.port or int(os.getenv("PORT", "7860"))
    open_browser = not args.no_browser
    run_server(host=args.host, port=port, verbose=args.verbose, open_browser=open_browser)


if __name__ == "__main__":
    main()
