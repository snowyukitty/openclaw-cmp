#!/usr/bin/env python3
"""Operator diagnostics for the cmp skill and companion commands."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


HOME = Path.home()
OPENCLAW_DIR = HOME / ".openclaw"
SKILLS_DIR = OPENCLAW_DIR / "skills"
CMP_DIR = SKILLS_DIR / "cmp"
STATE_PATH = CMP_DIR / "config" / "state.json"
CONFIG_PATH = OPENCLAW_DIR / "openclaw.json"
PLUGIN_PATH = OPENCLAW_DIR / "extensions" / "cmp" / "index.js"
PLUGIN_MANIFEST = OPENCLAW_DIR / "extensions" / "cmp" / "openclaw.plugin.json"
LAST_RUN_PATH = CMP_DIR / "logs" / "last-run.json"
TMP_LOG_DIR = Path("/tmp/openclaw")
STALE_SKILL_DIRS = [SKILLS_DIR / "cmp-status", SKILLS_DIR / "cmp-on", SKILLS_DIR / "cmp-off"]


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def run(cmd: list[str]) -> tuple[int, str]:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    text = proc.stdout.strip() or proc.stderr.strip()
    return proc.returncode, text


def check(name: str, ok: bool, detail: str) -> bool:
    status = "OK" if ok else "FAIL"
    print(f"[{status}] {name}: {detail}")
    return ok


def warn(name: str, detail: str) -> None:
    print(f"[WARN] {name}: {detail}")


def get_latest_gateway_log() -> Path | None:
    if not TMP_LOG_DIR.exists():
        return None
    logs = sorted(TMP_LOG_DIR.glob("openclaw-*.log"), key=lambda path: path.stat().st_mtime, reverse=True)
    return logs[0] if logs else None


def summarize_channel_auth(config: dict) -> list[tuple[str, bool, str]]:
    channels = (config.get("channels", {}) or {})
    results: list[tuple[str, bool, str]] = []

    telegram = channels.get("telegram", {}) or {}
    telegram_policy = telegram.get("groupPolicy")
    telegram_allow = telegram.get("groupAllowFrom", []) or []
    telegram_ok = telegram_policy != "allowlist" or bool(telegram_allow)
    results.append(("telegram group allowlist", telegram_ok, f"groupPolicy={telegram_policy}, groupAllowFrom={json.dumps(telegram_allow)}"))

    discord = channels.get("discord", {}) or {}
    discord_policy = discord.get("groupPolicy")
    guilds = discord.get("guilds", {}) or {}
    allowed_channels: list[str] = []
    for guild in guilds.values():
        channels_cfg = (guild or {}).get("channels", {}) or {}
        for channel_id, channel_cfg in channels_cfg.items():
            if (channel_cfg or {}).get("allow") is True:
                allowed_channels.append(str(channel_id))
    discord_ok = discord_policy != "allowlist" or bool(allowed_channels)
    results.append(("discord channel allowlist", discord_ok, f"groupPolicy={discord_policy}, allowedChannels={len(allowed_channels)}"))
    return results


def summarize_last_run() -> tuple[bool, str]:
    if not LAST_RUN_PATH.exists():
        return False, f"missing {LAST_RUN_PATH}"

    try:
        payload = load_json(LAST_RUN_PATH)
    except Exception as exc:  # pragma: no cover - diagnostics path
        return False, f"unreadable {LAST_RUN_PATH}: {exc}"

    traces = payload.get("traces", []) or []
    browser_status = next((item for item in traces if item.get("event") == "browser_status"), None)
    if browser_status:
        detail = json.dumps(
            {
                "running": browser_status.get("running"),
                "cdpReady": browser_status.get("cdpReady"),
                "chosenBrowser": browser_status.get("chosenBrowser"),
            },
            ensure_ascii=False,
        )
        return True, detail

    return True, "last-run exists but contains no browser_status trace"


def main() -> int:
    ok = True

    if not CONFIG_PATH.exists():
        print(f"[FAIL] config: missing {CONFIG_PATH}")
        return 1

    config = load_json(CONFIG_PATH)
    state = load_json(STATE_PATH)

    commands = config.get("commands", {}) or {}
    ok &= check("commands.native", commands.get("native") is True, str(commands.get("native")))
    ok &= check("commands.nativeSkills", commands.get("nativeSkills") is True, str(commands.get("nativeSkills")))
    ok &= check("commands.text", commands.get("text") is True, str(commands.get("text")))

    browser_cfg = config.get("browser", {}) or {}
    ok &= check("browser.enabled", browser_cfg.get("enabled") is True, str(browser_cfg.get("enabled")))
    ok &= check(
        "browser.evaluateEnabled",
        browser_cfg.get("evaluateEnabled") is True,
        str(browser_cfg.get("evaluateEnabled")),
    )

    plugins_allow = set((config.get("plugins", {}) or {}).get("allow", []))
    ok &= check("plugins.allow", "cmp" in plugins_allow, f"cmp in {sorted(plugins_allow)}")

    for stale_dir in STALE_SKILL_DIRS:
        ok &= check("stale skill dir", not stale_dir.exists(), str(stale_dir))

    ok &= check("cmp skill", (CMP_DIR / "SKILL.md").exists(), str(CMP_DIR / "SKILL.md"))
    ok &= check("cmp plugin", PLUGIN_PATH.exists(), str(PLUGIN_PATH))
    ok &= check("cmp manifest", PLUGIN_MANIFEST.exists(), str(PLUGIN_MANIFEST))

    enabled = [name for name, value in state.items() if value]
    ok &= check("enabled platforms", bool(enabled), ", ".join(enabled) if enabled else "none")

    for name, entry_ok, detail in summarize_channel_auth(config):
        ok &= check(name, entry_ok, detail)

    discord_cmds = ((config.get("channels", {}) or {}).get("discord", {}) or {}).get("commands", {})
    telegram_cmds = ((config.get("channels", {}) or {}).get("telegram", {}) or {}).get("commands", {})
    ok &= check("discord native commands", discord_cmds.get("native") is True, str(discord_cmds))
    ok &= check("telegram native commands", telegram_cmds.get("native") is True, str(telegram_cmds))

    rc, gateway_status = run(["openclaw", "gateway", "status"])
    gateway_running = rc == 0 and "Runtime: running" in gateway_status
    gateway_probe_ok = "RPC probe: ok" in gateway_status
    ok &= check("gateway status", gateway_running, gateway_status.splitlines()[0] if gateway_status else "(no output)")
    if gateway_probe_ok:
        check("gateway rpc probe", True, "RPC probe ok")
    elif gateway_running:
        warn("gateway rpc probe", "gateway service is running but probe is warming up or flaky on this host")
    else:
        ok &= check("gateway rpc probe", False, gateway_status)

    rc, gateway_probe = run(["openclaw", "gateway", "probe"])
    probe_ok = "Reachable: yes" in gateway_probe or "Connect: ok" in gateway_probe
    if probe_ok:
        check("gateway probe", True, "gateway reachable")
    elif gateway_running:
        warn("gateway probe", "gateway service is running but interactive probe did not return a clean success")
    else:
        ok &= check("gateway probe", False, gateway_probe.splitlines()[0] if gateway_probe else "(no output)")

    rc, skill_list = run(["openclaw", "skills", "list"])
    skill_ready = rc == 0 and "🔄 cmp" in skill_list and "✓ ready" in skill_list
    ok &= check("skill registry", skill_ready, "cmp should be listed as ready")

    latest_log = get_latest_gateway_log()
    if latest_log and latest_log.exists():
        log_text = latest_log.read_text(encoding="utf-8", errors="ignore")
        register_line = "[cmp] registering plugin commands: cmp-status (telegram: cmpstatus), cmp-on (telegram: cmpon), cmp-off (telegram: cmpoff), tool: cmp"
        ok &= check("plugin registration log", register_line in log_text, str(latest_log))
        bad_markers = [
            "duplicates an existing native command",
            "invalid for Telegram",
            "failed to deploy native commands",
        ]
        found_bad = [marker for marker in bad_markers if marker in log_text]
        ok &= check("native command log errors", not found_bad, ", ".join(found_bad) if found_bad else "none")
    else:
        ok &= check("gateway log", False, f"missing gateway log under {TMP_LOG_DIR}")

    last_run_ok, last_run_detail = summarize_last_run()
    ok &= check("last-run browser trace", last_run_ok, last_run_detail)

    # OpenClaw 2026.3.28 still uses the managed browser internally, but some
    # shells no longer expose `openclaw browser ...` directly. Keep the doctor
    # focused on config + run-log evidence instead of relying on that CLI.
    rc, browser_cmd_help = run(["openclaw", "browser", "status", "--json"])
    if rc != 0:
        warn("browser cli", "interactive shell command unavailable; relying on config + last-run traces")
    else:
        check("browser cli", True, browser_cmd_help)

    if not ok:
        print("\nRecovery:")
        print("1. openclaw gateway restart")
        print("2. python3 ~/.openclaw/skills/cmp/scripts/doctor.py")
        print("3. openclaw gateway probe")
        print("4. tail -n 200 /tmp/openclaw/openclaw-$(date +%F).log | rg 'cmp|native command|Telegram|Discord'")
        return 1

    print("\nCMP diagnostics passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
