"""
telegram_notifier.py  â€”  Threat-triggered Telegram Alert Pipeline
==================================================================
When a threat is detected (threat_score >= threshold):

  1.  Cooldown check â€” don't spam (1 alert per cam per 60s)
  2.  Index last 1 min of that camera's recordings â†’ ChromaDB
  3.  Query ChromaDB for recent segments
  4.  Call Tabi/OpenAI-compatible API to summarise what happened
  5.  Send Telegram message with summary + threat details

Setup (add to .env):
    TELEGRAM_BOT_TOKEN=<your bot token>   # from @BotFather
    TELEGRAM_CHAT_ID=<your chat id>       # from @userinfobot
    TELEGRAM_THREAT_THRESHOLD=0.6         # optional, default 0.6
    TELEGRAM_COOLDOWN_SEC=60              # optional, default 60
"""
from __future__ import annotations
import os, time, json, threading
from pathlib import Path
from datetime import datetime, timedelta
from typing import Optional

# â”€â”€ Config from env â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _cfg(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip().strip('"')


def _bot_token()  -> str: return _cfg("TELEGRAM_BOT_TOKEN")
def _chat_id()    -> str: return _cfg("TELEGRAM_CHAT_ID")
def _threshold()  -> float:
    try: return float(_cfg("TELEGRAM_THREAT_THRESHOLD", "0.6"))
    except: return 0.6
def _cooldown()   -> float:
    try: return float(_cfg("TELEGRAM_COOLDOWN_SEC", "60"))
    except: return 60.0


def is_configured() -> bool:
    return bool(_bot_token() and _chat_id())


# â”€â”€ Cooldown tracker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

_last_alert: dict[str, float] = {}   # cam_id â†’ last alert epoch
_lock = threading.Lock()

def _can_alert(cam_id: str) -> bool:
    now = time.time()
    with _lock:
        last = _last_alert.get(cam_id, 0)
        if now - last < _cooldown():
            return False
        _last_alert[cam_id] = now
        return True


# â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _recordings_dir() -> Path:
    try:
        from backend.db import get_setting
        saved = get_setting("recordings_dir", "")
        if saved and Path(saved).exists():
            return Path(saved)
    except Exception:
        pass
    p = Path(__file__).resolve().parents[1] / "recordings"  # E:\servelanceSystem\recordings
    p.mkdir(parents=True, exist_ok=True)
    return p


def _fmt_sec(sec: float) -> str:
    m, s = divmod(int(sec), 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


# â”€â”€ Step 2: Index last N minutes of recording for cam â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _get_recent_segments(cam_id: str, minutes: int = 1) -> list[dict]:
    """
    Find most-recent MP4 for cam_id recorded in the last N minutes,
    trigger on-the-fly indexing, return ChromaDB segments.
    """
    rec_dir = _recordings_dir()
    cutoff  = datetime.now() - timedelta(minutes=minutes)

    # Prefer files that start with cam_id, fall back to any recent file
    candidates = sorted(rec_dir.glob("*.mp4"), key=lambda f: f.stat().st_mtime, reverse=True)
    recent = [
        f for f in candidates[:15]
        if datetime.fromtimestamp(f.stat().st_mtime) >= cutoff
    ]
    # Prefer cam-specific files
    cam_files = [f for f in recent if cam_id[:8] in f.stem]
    target_files = cam_files or recent[:2]

    segments: list[dict] = []
    for fpath in target_files:
        rid = fpath.stem
        try:
            from backend.ai.VideoSemantic.indexer import (
                is_asset_indexed, index_video, get_segments_for_recording
            )
            if not is_asset_indexed(rid):
                print(f"[TelegramNotifier] Indexing {fpath.name} for alertâ€¦", flush=True)
                index_video(str(fpath), rid)

            segs = get_segments_for_recording(rid)
            for s in segs:
                s["file"] = fpath.name
            segments.extend(segs)
        except Exception as e:
            print(f"[TelegramNotifier] Index error {fpath.name}: {e}", flush=True)

    return segments


# â”€â”€ Step 3+4: Summarise via Tabi API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _summarise(cam_id: str, persons: list[dict], max_threat: float, segments: list[dict]) -> str:
    """
    Call the LLM API to generate a concise threat summary.
    """
    try:
        import httpx
        api_key  = _cfg("TABI_API_KEY") or _cfg("OPENAI_API_KEY")
        base_url = _cfg("TABI_BASE_URL", "https://tabitoken.com/v1")
        model    = _cfg("FADE_AI_MODEL", "gpt-4o-mini")

        # Build context from persons
        person_desc = "\n".join(
            f"  - {p['pid']}: {p['activity']}, threat {int(p['threat_score']*100)}%, class={p['class']}, conf={int(p['conf']*100)}%"
            for p in persons
        )

        # Build context from video segments
        seg_desc = ""
        if segments:
            seg_lines = [
                f"  [{_fmt_sec(s['start_s'])}â€“{_fmt_sec(s['end_s'])}] {s.get('text','')}"
                for s in segments[:6]
            ]
            seg_desc = "\nRecent video analysis:\n" + "\n".join(seg_lines)

        ts_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        prompt = f"""You are a surveillance security AI. A threat has been detected.

Camera: {cam_id}
Time: {ts_str}
Overall threat level: {int(max_threat*100)}%

Detected persons:
{person_desc}
{seg_desc}

Write a concise, factual security alert in 3-4 sentences:
1. State what was detected and where
2. Describe the most concerning activity
3. Recommend immediate action
Keep it clear and professional. Do NOT use markdown."""

        resp = httpx.post(
            f"{base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type":  "application/json",
            },
            json={
                "model":    model,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 200,
                "temperature": 0.3,
            },
            timeout=20.0,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"].strip()

    except Exception as e:
        # Fallback summary if API fails
        acts = ", ".join(set(p["activity"] for p in persons))
        return (
            f"THREAT DETECTED on camera {cam_id}. "
            f"{len(persons)} person(s) detected â€” activities: {acts}. "
            f"Threat level: {int(max_threat*100)}%. "
            f"Immediate review recommended."
        )


# â”€â”€ Step 5: Send Telegram message â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _send_telegram(text: str) -> bool:
    try:
        import httpx
        token   = _bot_token()
        chat_id = _chat_id()
        url     = f"https://api.telegram.org/bot{token}/sendMessage"
        resp    = httpx.post(url, json={
            "chat_id":    chat_id,
            "text":       text,
            "parse_mode": "HTML",
        }, timeout=10.0)
        ok = resp.json().get("ok", False)
        if ok:
            print("[TelegramNotifier] Alert sent âœ“", flush=True)
        else:
            print(f"[TelegramNotifier] Send failed: {resp.text}", flush=True)
        return ok
    except Exception as e:
        print(f"[TelegramNotifier] Telegram error: {e}", flush=True)
        return False


# â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def notify_threat(cam_id: str, persons: list[dict], max_threat: float) -> None:
    """
    Entry point called from detection.py on each frame where alert=True.
    Runs the full pipeline in a daemon thread so it never blocks inference.
    """
    if not is_configured():
        return
    if max_threat < _threshold():
        return
    if not _can_alert(cam_id):
        return   # cooldown

    # Run pipeline in background so detection loop isn't blocked
    t = threading.Thread(
        target=_pipeline,
        args=(cam_id, persons, max_threat),
        daemon=True,
        name=f"tg-alert-{cam_id[:8]}",
    )
    t.start()


def _pipeline(cam_id: str, persons: list[dict], max_threat: float) -> None:
    """Full async pipeline â€” runs in background thread."""
    print(f"[TelegramNotifier] Pipeline start for cam={cam_id} threat={max_threat:.0%}", flush=True)

    # Step 2: Index + get segments
    segments = _get_recent_segments(cam_id, minutes=1)

    # Step 3+4: Summarise
    summary = _summarise(cam_id, persons, max_threat, segments)

    # Step 5: Format and send
    ts_str    = datetime.now().strftime("%H:%M:%S")
    threat_pct= int(max_threat * 100)
    bar       = "ðŸ”´" * (threat_pct // 20) + "â¬œ" * (5 - threat_pct // 20)

    person_lines = "\n".join(
        f"  â€¢ <b>{p['pid']}</b> â€” {p['activity']} ({int(p['threat_score']*100)}% threat)"
        for p in persons[:5]
    )

    msg = (
        f"ðŸš¨ <b>THREAT ALERT</b> â€” {ts_str}\n"
        f"ðŸ“· Camera: <code>{cam_id[:12]}</code>\n"
        f"âš ï¸ Threat Level: {bar} <b>{threat_pct}%</b>\n"
        f"ðŸ‘¥ Persons ({len(persons)}):\n{person_lines}\n\n"
        f"ðŸ“‹ <b>AI Analysis:</b>\n{summary}"
    )

    _send_telegram(msg)
    print(f"[TelegramNotifier] Pipeline done for cam={cam_id}", flush=True)


# â”€â”€ Connectivity test â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def test_connection() -> dict:
    """Test Telegram credentials. Returns {ok, error}."""
    if not _bot_token():
        return {"ok": False, "error": "TELEGRAM_BOT_TOKEN not set in .env"}
    if not _chat_id():
        return {"ok": False, "error": "TELEGRAM_CHAT_ID not set in .env"}
    try:
        import httpx
        r = httpx.get(
            f"https://api.telegram.org/bot{_bot_token()}/getMe",
            timeout=8.0,
        )
        data = r.json()
        if data.get("ok"):
            bot_name = data["result"]["username"]
            return {"ok": True, "bot": f"@{bot_name}", "chat_id": _chat_id()}
        return {"ok": False, "error": data.get("description", "Unknown error")}
    except Exception as e:
        return {"ok": False, "error": str(e)}

