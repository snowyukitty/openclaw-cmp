#!/usr/bin/env python3

import json
import sys
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent.parent
STATE_PATH = BASE_DIR / "config" / "state.json"
PLATFORMS = ("chatgpt", "claude", "gemini", "grok")


def load_state() -> dict[str, bool]:
    with STATE_PATH.open("r", encoding="utf-8") as fh:
        data = json.load(fh)

    missing = [name for name in PLATFORMS if name not in data]
    if missing:
        raise SystemExit(f"state.json missing keys: {', '.join(missing)}")

    return {name: bool(data[name]) for name in PLATFORMS}


def save_state(state: dict[str, bool]) -> None:
    with STATE_PATH.open("w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)
        fh.write("\n")


def print_status(state: dict[str, bool]) -> None:
    for name in PLATFORMS:
        print(f"{name}: {'ON' if state[name] else 'OFF'}")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("Usage: state.py status|enabled [--json] | set <platform> on|off | set-all on|off", file=sys.stderr)
        return 2

    state = load_state()
    command = argv[1]

    if command == "status":
        if "--json" in argv[2:]:
            print(json.dumps(state, ensure_ascii=False))
        else:
            print_status(state)
        return 0

    if command == "enabled":
        enabled = [name for name, value in state.items() if value]
        if "--json" in argv[2:]:
            print(json.dumps(enabled, ensure_ascii=False))
        else:
            for name in enabled:
                print(name)
        return 0

    if command == "set" and len(argv) == 4:
        platform, mode = argv[2], argv[3].lower()
        if platform not in PLATFORMS:
            print(f"Unknown platform: {platform}", file=sys.stderr)
            return 2
        if mode not in {"on", "off"}:
            print(f"Unknown mode: {mode}", file=sys.stderr)
            return 2
        state[platform] = mode == "on"
        save_state(state)
        print_status(state)
        return 0

    if command == "set-all" and len(argv) == 3:
        mode = argv[2].lower()
        if mode not in {"on", "off"}:
            print(f"Unknown mode: {mode}", file=sys.stderr)
            return 2
        value = mode == "on"
        for platform in PLATFORMS:
            state[platform] = value
        save_state(state)
        print_status(state)
        return 0

    print("Usage: state.py status|enabled [--json] | set <platform> on|off | set-all on|off", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
