"""
mobile.py — LAN mobile camera support.

Phones open /mobile/page?cam=<id> in their browser.
The page captures the phone camera and POSTs JPEG frames back.
The Electron app then reads from /mobile/stream/<id>.

GET  /mobile/lan-ip              → local LAN IP
POST /mobile/frame/{cam_id}      → receive JPEG frame from phone
GET  /mobile/stream/{cam_id}     → MJPEG stream of that phone camera
GET  /mobile/page                → HTML sender page for the phone
"""
from __future__ import annotations

import asyncio
import socket
import time
from typing import Optional

from fastapi import APIRouter, UploadFile, File
from fastapi.responses import HTMLResponse, StreamingResponse, Response

router = APIRouter(prefix="/mobile", tags=["mobile"])

# ── In-memory frame buffers (not persisted — frames are transient) ─────────────
# { cam_id: { name, last_frame: bytes|None, last_seen: float } }
_cameras: dict[str, dict] = {}


def _lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


# ── Helpers called by config.py ────────────────────────────────────────────────

def register_camera(cam_id: str, name: str) -> None:
    """Pre-warm a camera slot so /mobile/frame/{cam_id} can receive frames."""
    if cam_id not in _cameras:
        _cameras[cam_id] = {"name": name, "last_frame": None, "last_seen": 0}


def rename_camera(cam_id: str, name: str) -> None:
    if cam_id in _cameras:
        _cameras[cam_id]["name"] = name


def unregister_camera(cam_id: str) -> None:
    _cameras.pop(cam_id, None)


def get_camera_status() -> dict[str, bool]:
    """Return {cam_id: connected} based on last_seen timestamp."""
    now = time.time()
    return {cid: (now - info.get("last_seen", 0)) < 6 for cid, info in _cameras.items()}


def load_cameras_from_db() -> None:
    """Called once at startup to restore persisted mobile cameras into memory."""
    try:
        from backend.db import cam_list
        for cam in cam_list():
            if cam["kind"] == "mobile":
                register_camera(cam["id"], cam["name"])
        print(f"[mobile] Loaded {len(_cameras)} camera(s) from DB", flush=True)
    except Exception as e:
        print(f"[mobile] Could not load cameras from DB: {e}", flush=True)


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/lan-ip")
def get_lan_ip():
    return {"ip": _lan_ip()}


@router.post("/frame/{cam_id}")
async def receive_frame(cam_id: str, file: UploadFile = File(...)):
    """Phone POSTs a JPEG frame here."""
    cam_id = cam_id.strip()   # strip accidental URL-decoded spaces
    data = await file.read()
    if cam_id not in _cameras:
        _cameras[cam_id] = {"name": f"Mobile {cam_id[:6]}", "last_frame": None, "last_seen": 0}
    _cameras[cam_id]["last_frame"] = data
    _cameras[cam_id]["last_seen"]  = time.time()

    # Pipe frame to disk recorder (auto-starts MP4 recording on first frame)
    try:
        from backend.frame_recorder import on_frame as _rec_frame
        _rec_frame(cam_id, data)
    except Exception:
        pass  # never crash the frame pipeline

    return Response(status_code=204)



_WAITING_JPEG = None

def _get_waiting_jpeg() -> bytes:
    """Generate (once) a small 'Waiting for camera…' placeholder JPEG."""
    global _WAITING_JPEG
    if _WAITING_JPEG:
        return _WAITING_JPEG
    try:
        from PIL import Image, ImageDraw, ImageFont
        img  = Image.new("RGB", (640, 360), color=(10, 10, 20))
        draw = ImageDraw.Draw(img)
        draw.rectangle([0, 0, 640, 360], fill=(10, 10, 20))
        # Simple text
        draw.text((200, 155), "Waiting for camera…", fill=(120, 100, 255))
        draw.text((250, 185), "Open link on phone",  fill=(100, 100, 120))
        import io
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=60)
        _WAITING_JPEG = buf.getvalue()
    except Exception:
        # Minimal valid 1x1 grey JPEG
        _WAITING_JPEG = (
            b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
            b"\xff\xdb\x00C\x00\x08\x06\x06\x07\x06\x05\x08\x07\x07\x07\t\t"
            b"\x08\n\x0c\x14\r\x0c\x0b\x0b\x0c\x19\x12\x13\x0f\x14\x1d\x1a"
            b"\x1f\x1e\x1d\x1a\x1c\x1c $.' \",#\x1c\x1c(7),01444\x1f'9=82<.342\x1eC\xff\xc0"
            b"\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00\xff\xc4\x00\x1f\x00"
            b"\x00\x01\x05\x01\x01\x01\x01\x01\x01\x00\x00\x00\x00\x00\x00\x00"
            b"\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\x0b\xff\xc4\x00\xb5\x10"
            b"\x00\x02\x01\x03\x03\x02\x04\x03\x05\x05\x04\x04\x00\x00\x01}"
            b"\x01\x02\x03\x00\x04\x11\x05\x12!1A\x06\x13Qa\x07\"q\x142\x81"
            b"\x91\xa1\x08#B\xb1\xc1\x15R\xd1\xf0$3br\x82\t\n\x16\x17\x18\x19"
            b"\x1a%&\'()*456789:CDEFGHIJSTUVWXYZcdefghijstuvwxyz\x83\x84\x85"
            b"\x86\x87\x88\x89\x8a\x92\x93\x94\x95\x96\x97\x98\x99\x9a\xa2\xa3"
            b"\xa4\xa5\xa6\xa7\xa8\xa9\xaa\xb2\xb3\xb4\xb5\xb6\xb7\xb8\xb9\xba"
            b"\xc2\xc3\xc4\xc5\xc6\xc7\xc8\xc9\xca\xd2\xd3\xd4\xd5\xd6\xd7\xd8"
            b"\xd9\xda\xe1\xe2\xe3\xe4\xe5\xe6\xe7\xe8\xe9\xea\xf1\xf2\xf3\xf4"
            b"\xf5\xf6\xf7\xf8\xf9\xfa\xff\xda\x00\x08\x01\x01\x00\x00?\x00\xfb"
            b"Tx\xff\xd9"
        )
    return _WAITING_JPEG


async def _mjpeg_gen(cam_id: str):
    """Yield MJPEG frames. Yields a waiting placeholder when phone not connected."""
    wait_tick = 0
    while True:
        info  = _cameras.get(cam_id)
        frame = info.get("last_frame") if info else None
        connected = info and (time.time() - info.get("last_seen", 0)) < 6

        if frame and connected:
            wait_tick = 0
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n"
                + frame
                + b"\r\n"
            )
            await asyncio.sleep(1 / 25)   # 25 fps
        else:
            # Send waiting placeholder at ~1 fps so the <img> shows something
            wait_tick += 1
            if wait_tick % 25 == 1:   # every ~1 second
                placeholder = _get_waiting_jpeg()
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n\r\n"
                    + placeholder
                    + b"\r\n"
                )
            await asyncio.sleep(1 / 25)


@router.get("/stream/{cam_id}")
async def stream(cam_id: str):
    cam_id = cam_id.strip()
    # Auto-register unknown cam so stream opens even before phone connects
    if cam_id not in _cameras:
        _cameras[cam_id] = {"name": f"Mobile {cam_id[:6]}", "last_frame": None, "last_seen": 0}
    return StreamingResponse(
        _mjpeg_gen(cam_id),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-cache, no-store"},
    )


# ── Mobile sender page (served to phones) ─────────────────────────────────────

@router.get("/page")
def mobile_page(cam: str = "default"):
    cam = cam.strip()   # strip accidental spaces from URL decode
    html = _MOBILE_HTML.replace("__CAM_ID__", cam)
    return HTMLResponse(content=html)


_MOBILE_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>SurvAIllance · Mobile Cam</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #07070f; color: #f0f0ff;
    font-family: system-ui, -apple-system, sans-serif;
    min-height: 100dvh;
    display: flex; flex-direction: column; align-items: center;
    padding: 24px 20px; gap: 16px;
  }
  .logo { font-size: 20px; font-weight: 800; }
  .logo span { color: #7c6fff; }
  #status {
    font-size: 13px; padding: 6px 16px;
    border-radius: 20px;
    background: rgba(255,255,255,0.07);
    border: 1px solid rgba(255,255,255,0.12);
    transition: all 0.3s;
  }
  #status.ok   { background: rgba(34,197,94,.15); border-color: rgba(34,197,94,.4); color: #86efac; }
  #status.err  { background: rgba(239,68,68,.15);  border-color: rgba(239,68,68,.4); color: #fca5a5; }
  video {
    width: 100%; max-width: 420px; border-radius: 14px;
    border: 1px solid rgba(255,255,255,0.1); background: #000;
    aspect-ratio: 16/9; object-fit: cover;
  }
  canvas { display: none; }
  #info { font-size: 11px; color: rgba(255,255,255,0.35); font-family: monospace; text-align: center; }
  #startBtn {
    background: rgba(124,111,255,0.2);
    border: 1px solid rgba(124,111,255,0.5);
    color: #a89fff; font-size: 15px; font-weight: 600;
    padding: 12px 32px; border-radius: 12px; cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    width: 100%; max-width: 260px;
  }
  #startBtn:active { opacity: 0.7; }
</style>
</head>
<body>
  <div class="logo">Surv<span>AI</span>llance</div>
  <div id="status">Tap Start to connect camera</div>
  <video id="v" autoplay playsinline muted></video>
  <canvas id="c"></canvas>
  <div id="info">Camera ID: __CAM_ID__</div>
  <button id="startBtn">📷 Start Camera</button>

<script>
const CAM_ID  = "__CAM_ID__";
const BASE    = window.location.origin;
const v       = document.getElementById("v");
const c       = document.getElementById("c");
const ctx     = c.getContext("2d");
const status  = document.getElementById("status");
const btn     = document.getElementById("startBtn");
const info    = document.getElementById("info");

let running = false, frames = 0, lastTime = Date.now(), errors = 0;

async function startCamera() {
  status.textContent = "Requesting camera…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    v.srcObject = stream;
    await v.play();
    btn.style.display = "none";
    status.textContent = "Connecting…";
    running = true;
    sendLoop();
  } catch (e) {
    status.textContent = "Error: " + e.message;
    status.className = "err";
  }
}

async function sendLoop() {
  if (!running) return;
  if (v.readyState >= 2) {
    c.width  = v.videoWidth  || 640;
    c.height = v.videoHeight || 480;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.72));
    if (blob) {
      const form = new FormData();
      form.append("file", blob, "frame.jpg");
      try {
        await fetch(`${BASE}/mobile/frame/${CAM_ID}`, { method: "POST", body: form });
        errors = 0;
        frames++;
        if (Date.now() - lastTime >= 1000) {
          info.textContent = `${frames} fps · cam: ${CAM_ID} · ${c.width}×${c.height}`;
          frames = 0; lastTime = Date.now();
          status.textContent = "Streaming ✓";
          status.className = "ok";
        }
      } catch (_) {
        errors++;
        if (errors > 3) { status.textContent = "Connection lost…"; status.className = "err"; }
      }
    }
  }
  setTimeout(sendLoop, 80); // ~12 fps
}

btn.addEventListener("click", startCamera);
startCamera();
</script>
</body>
</html>"""
