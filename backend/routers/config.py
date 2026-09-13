"""
config.py — CRUD REST API for cameras (SQLite) and viewports (SQLite).

GET    /config/cameras              → list all cameras
POST   /config/cameras              → add camera
PATCH  /config/cameras/{id}         → rename camera
DELETE /config/cameras/{id}         → remove camera

GET    /config/viewports            → list all viewports
POST   /config/viewports            → add viewport
PATCH  /config/viewports/{id}       → update cam_id / title / inference
DELETE /config/viewports/{id}       → remove viewport
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from backend import db

router = APIRouter(prefix="/config", tags=["config"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class CameraCreate(BaseModel):
    name: str
    kind: str = "mobile"   # 'mobile' | 'local'

class CameraUpdate(BaseModel):
    name: str

class ViewportCreate(BaseModel):
    title: Optional[str] = None
    cam_id: Optional[str] = None

class ViewportUpdate(BaseModel):
    title:     Optional[str]  = None
    cam_id:    Optional[str]  = None
    inference: Optional[int]  = None   # 0 or 1
    position:  Optional[int]  = None


# ── Camera endpoints ──────────────────────────────────────────────────────────

@router.get("/cameras")
def list_cameras():
    cams = db.cam_list()
    # Annotate mobile cams with live connection status from mobile router
    try:
        from backend.routers.mobile import get_camera_status
        status_map = get_camera_status()
    except Exception:
        status_map = {}
    for c in cams:
        if c["kind"] == "mobile":
            c["connected"] = status_map.get(c["id"], False)
        else:
            c["connected"] = None   # local cams — browser knows
    return cams


@router.post("/cameras", status_code=201)
def add_camera(body: CameraCreate):
    import sqlite3
    for _ in range(3):   # retry on the astronomically-unlikely ID collision
        cam_id = uuid.uuid4().hex[:12]   # 12 hex chars = 48-bit space
        try:
            db.cam_insert(cam_id, body.name, body.kind)
            break
        except sqlite3.IntegrityError:
            continue   # collision — try a new ID
    else:
        # Give up and use full UUID
        cam_id = uuid.uuid4().hex
        db.cam_insert(cam_id, body.name, body.kind)

    if body.kind == "mobile":
        try:
            from backend.routers.mobile import register_camera
            register_camera(cam_id, body.name)
        except Exception:
            pass
    return {"id": cam_id, "name": body.name, "kind": body.kind, "connected": False}


@router.patch("/cameras/{cam_id}")
def update_camera(cam_id: str, body: CameraUpdate):
    ok = db.cam_update(cam_id, body.name)
    if ok:
        try:
            from backend.routers.mobile import rename_camera
            rename_camera(cam_id, body.name)
        except Exception:
            pass
    return {"ok": ok}


@router.delete("/cameras/{cam_id}")
def delete_camera(cam_id: str):
    db.cam_delete(cam_id)
    try:
        from backend.routers.mobile import unregister_camera
        unregister_camera(cam_id)
    except Exception:
        pass
    return {"ok": True}


# ── Viewport endpoints ────────────────────────────────────────────────────────

@router.get("/viewports")
def list_viewports():
    return db.vp_list()


@router.post("/viewports", status_code=201)
def add_viewport(body: ViewportCreate):
    existing = db.vp_list()
    position = len(existing)
    vp_id    = str(uuid.uuid4())[:8]
    title    = body.title or f"Viewport {position + 1}"
    vp       = db.vp_insert(vp_id, title, position)
    if body.cam_id:
        db.vp_update(vp_id, cam_id=body.cam_id)
        vp["cam_id"] = body.cam_id
    return vp


@router.patch("/viewports/{vp_id}")
def update_viewport(vp_id: str, body: ViewportUpdate):
    # Manual extraction — works with both Pydantic v1 and v2
    fields: dict = {}
    if body.title     is not None: fields["title"]     = body.title
    if body.cam_id    is not None: fields["cam_id"]    = body.cam_id
    if body.inference is not None: fields["inference"] = body.inference
    if body.position  is not None: fields["position"]  = body.position
    ok = db.vp_update(vp_id, **fields) if fields else False
    return {"ok": ok}


@router.delete("/viewports/{vp_id}")
def delete_viewport(vp_id: str):
    ok = db.vp_delete(vp_id)
    return {"ok": ok}


# ── .env patcher ──────────────────────────────────────────────────────────────

@router.post("/env")
def patch_env(body: dict):
    """
    Upsert key=value pairs into the project root .env file.
    Existing keys are updated in-place; new keys are appended.
    """
    from pathlib import Path
    import os, re
    env_path = Path(__file__).resolve().parents[2] / ".env"  # E:\servelanceSystem\.env

    # Read existing lines
    lines: list[str] = []
    if env_path.exists():
        lines = env_path.read_text(encoding="utf-8").splitlines()

    updated_keys: set[str] = set()
    new_lines: list[str] = []

    for line in lines:
        matched = False
        for key, val in body.items():
            pattern = re.compile(rf"^{re.escape(key)}\s*=")
            if pattern.match(line):
                new_lines.append(f"{key}={val}")
                updated_keys.add(key)
                matched = True
                break
        if not matched:
            new_lines.append(line)

    # Append keys that weren't in the file yet
    for key, val in body.items():
        if key not in updated_keys:
            new_lines.append(f"{key}={val}")

    env_path.write_text("\n".join(new_lines) + "\n", encoding="utf-8")

    # Also update the live process env so the running backend picks it up immediately
    for key, val in body.items():
        os.environ[key] = str(val)

    return {"ok": True, "updated": list(body.keys())}
