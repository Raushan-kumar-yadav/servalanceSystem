"""
db.py — SQLite persistence for camera configs and viewport layouts.
Uses Python's built-in sqlite3 (no extra deps needed).
"""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

# Place the DB next to the backend package (project root)
DB_PATH = Path(__file__).parent.parent / "surveillance.db"

# One lock for write serialisation (sqlite3 allows multi-read but one write at a time)
_write_lock = threading.Lock()


@contextmanager
def _db():
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")   # better concurrency
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    """Create tables if they don't exist yet (idempotent)."""
    with _db() as c:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS cameras (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                kind       TEXT NOT NULL DEFAULT 'mobile',
                created_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS viewports (
                id         TEXT PRIMARY KEY,
                title      TEXT NOT NULL DEFAULT 'Viewport',
                cam_id     TEXT,
                position   INTEGER NOT NULL DEFAULT 0,
                inference  INTEGER NOT NULL DEFAULT 1,
                created_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL DEFAULT ''
            );
        """)

# ── Settings helpers ───────────────────────────────────────────────────────────

def get_setting(key: str, default: str = "") -> str:
    with _db() as c:
        row = c.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    with _write_lock, _db() as c:
        c.execute(
            "INSERT INTO settings(key, value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


# ── Camera helpers ─────────────────────────────────────────────────────────────

def cam_list() -> list[dict]:
    with _db() as c:
        rows = c.execute(
            "SELECT id, name, kind, created_at FROM cameras ORDER BY created_at"
        ).fetchall()
    return [dict(r) for r in rows]


def cam_get(cam_id: str) -> dict | None:
    with _db() as c:
        row = c.execute("SELECT * FROM cameras WHERE id = ?", (cam_id,)).fetchone()
    return dict(row) if row else None


def cam_insert(cam_id: str, name: str, kind: str) -> dict:
    import time
    with _write_lock, _db() as c:
        c.execute(
            "INSERT INTO cameras (id, name, kind, created_at) VALUES (?,?,?,?)",
            (cam_id, name, kind, time.time()),
        )
    return {"id": cam_id, "name": name, "kind": kind}


def cam_update(cam_id: str, name: str) -> bool:
    with _write_lock, _db() as c:
        cur = c.execute("UPDATE cameras SET name = ? WHERE id = ?", (name, cam_id))
        return cur.rowcount > 0


def cam_delete(cam_id: str) -> bool:
    with _write_lock, _db() as c:
        cur = c.execute("DELETE FROM cameras WHERE id = ?", (cam_id,))
        ok = cur.rowcount > 0
        # Nullify any viewports pointing to this cam
        c.execute("UPDATE viewports SET cam_id = NULL WHERE cam_id = ?", (cam_id,))
    return ok


# ── Viewport helpers ───────────────────────────────────────────────────────────

def vp_list() -> list[dict]:
    with _db() as c:
        rows = c.execute(
            "SELECT id, title, cam_id, position, inference, created_at "
            "FROM viewports ORDER BY position, created_at"
        ).fetchall()
    return [dict(r) for r in rows]


def vp_insert(vp_id: str, title: str, position: int) -> dict:
    import time
    with _write_lock, _db() as c:
        c.execute(
            "INSERT INTO viewports (id, title, position, created_at) VALUES (?,?,?,?)",
            (vp_id, title, position, time.time()),
        )
    return {"id": vp_id, "title": title, "cam_id": None, "position": position, "inference": 1}


def vp_update(vp_id: str, **fields) -> bool:
    allowed = {"title", "cam_id", "position", "inference"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return False
    cols  = ", ".join(f"{k} = ?" for k in updates)
    vals  = list(updates.values()) + [vp_id]
    with _write_lock, _db() as c:
        cur = c.execute(f"UPDATE viewports SET {cols} WHERE id = ?", vals)
        return cur.rowcount > 0


def vp_delete(vp_id: str) -> bool:
    with _write_lock, _db() as c:
        cur = c.execute("DELETE FROM viewports WHERE id = ?", (vp_id,))
        return cur.rowcount > 0
