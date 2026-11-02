"""Utility to verify Telegram bot credentials and send a test alert.

Usage:
    python tools/check_telegram.py
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent



def load_env(path: Path) -> dict[str, str]:
    env = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        env[key.strip()] = val.strip().strip("'\"")
    return env


def mask_token(token: str) -> str:
    if len(token) < 10:
        return "****"
    return f"{token[:6]}...{token[-4:]}"


def main() -> int:
    env_path = ROOT / ".env"
    env = load_env(env_path)

    token = env.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = env.get("TELEGRAM_CHAT_ID", "").strip()

    print("=" * 60)
    print("ColdChain Telegram Bot Verification")
    print("=" * 60)

    if not token or not chat_id:
        print("❌ Error: Missing credentials in .env")
        print(f"  TELEGRAM_BOT_TOKEN : {'[FOUND: ' + mask_token(token) + ']' if token else '[EMPTY]'}")
        print(f"  TELEGRAM_CHAT_ID   : {chat_id if chat_id else '[EMPTY]'}")
        print("\nPlease open .env and save both values, then run this again.")
        return 1

    print(f"ℹ️ Found token   : {mask_token(token)}")
    print(f"ℹ️ Target chat ID: {chat_id}")
    print("\n1. Verifying bot token with Telegram API...")

    # Step 1: getMe
    try:
        req = urllib.request.Request(f"https://api.telegram.org/bot{token}/getMe")
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("ok"):
                bot = data.get("result", {})
                print(f"✅ Bot connected: @{bot.get('username')} ({bot.get('first_name')})")
            else:
                print(f"❌ Telegram rejected token: {data}")
                return 1
    except urllib.error.HTTPError as e:
        print(f"❌ Failed to authenticate token: HTTP {e.code} ({e.reason})")
        print("   Double-check that you copied the full token correctly from @BotFather.")
        return 1
    except Exception as e:
        print(f"❌ Connection error: {e}")
        return 1

    # Step 2: send test message
    print("\n2. Sending test alert message to your chat...")
    text = (
        "❄️ *ColdChain Alert Bot connected successfully!* ❄️\n\n"
        "✅ Your Telegram bot credentials in `.env` are valid.\n"
        "🔔 Real-time alerts (temperature breaches, door alarms) will be sent here.\n\n"
        "_ColdChain Vaccine & Medicine Storage Monitor_"
    )
    payload = json.dumps({
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "Markdown",
    }).encode("utf-8")

    try:
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{token}/sendMessage",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("ok"):
                print("🎉 SUCCESS! Test message delivered to your Telegram.")
                print("   Check your Telegram app right now.")
                return 0
            else:
                print(f"❌ Telegram sendMessage error: {data}")
                return 1
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="ignore")
        print(f"❌ Failed to send message: HTTP {e.code} ({e.reason})")
        if "chat not found" in err_body or e.code == 400:
            print("   👉 Cause: Have you clicked 'Start' in the chat with your bot?")
            print("   Before a bot can message you, open the bot in Telegram and click /start.")
        print(f"   Details: {err_body}")
        return 1
    except Exception as e:
        print(f"❌ Connection error: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
