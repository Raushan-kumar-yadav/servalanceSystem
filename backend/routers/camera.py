"""
camera.py — Real-time camera capture & MJPEG streaming via FastAPI.

Endpoints:
  GET  /camera/list          → list all connected cameras
  POST /camera/select/{id}   → switch active camera
  GET  /camera/stream?cam=N  → MJPEG stream (multipart/x-mixed-replace)
  GET  /camera/frame?cam=N   → single JPEG snapshot
"""
from __future__ import annotations
import asyncio
import cv2
from fastapi import APIRouter
from fastapi.responses import StreamingResponse, Response

router = APIRouter(prefix="/camera", tags=["camera"])

# ── Global capture state ───────────────────────────────────────────────────────
_captures: dict[int, cv2.VideoCapture] = {}
_active_cam: int = 0


def _open(cam_id: int) -> cv2.VideoCapture:
    """Return (and cache) a VideoCapture for the given index.
    Tries MSMF first (best for Windows built-in cams), falls back to default."""
    if cam_id not in _captures or not _captures[cam_id].isOpened():
        # Try MSMF (Microsoft Media Foundation) — best for Windows laptop cams
        cap = cv2.VideoCapture(cam_id, cv2.CAP_MSMF)
        if not cap.isOpened():
            cap = cv2.VideoCapture(cam_id)   # auto-select backend
        cap.set(cv2.CAP_PROP_FRAME_WIDTH,  1280)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        cap.set(cv2.CAP_PROP_FPS,          30)
        _captures[cam_id] = cap
    return _captures[cam_id]


def _release_all():
    for cap in _captures.values():
        cap.release()
    _captures.clear()


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/list")
def list_cameras():
    """Probe up to 6 indices and return those that open successfully."""
    results = []
    for i in range(6):
        cap = cv2.VideoCapture(i, cv2.CAP_MSMF)
        if not cap.isOpened():
            cap = cv2.VideoCapture(i)
        if cap.isOpened():
            w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            results.append({"id": i, "name": f"Camera {i}  ({w}×{h})"})
            cap.release()
    return results


@router.post("/select/{cam_id}")
def select_camera(cam_id: int):
    global _active_cam
    _active_cam = cam_id
    _open(cam_id)          # pre-warm
    return {"ok": True, "active": cam_id}


@router.get("/frame")
def single_frame(cam: int = 0):
    """Return a single JPEG snapshot — useful for thumbnails / polling."""
    cap = _open(cam)
    ret, frame = cap.read()
    if not ret:
        return Response(status_code=503, content="Camera not available")
    _, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return Response(content=jpeg.tobytes(), media_type="image/jpeg")


async def _mjpeg_gen(cam_id: int):
    """Async generator that yields MJPEG boundary-separated JPEG frames."""
    cap = _open(cam_id)
    loop = asyncio.get_event_loop()

    while True:
        # Read in thread-pool so we don't block the event loop
        ret, frame = await loop.run_in_executor(None, cap.read)
        if not ret:
            # Camera gone — try to reconnect once
            _captures.pop(cam_id, None)
            cap = _open(cam_id)
            await asyncio.sleep(0.5)
            continue

        _, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n\r\n"
            + jpeg.tobytes()
            + b"\r\n"
        )
        await asyncio.sleep(1 / 30)   # target 30 fps


@router.get("/stream")
async def stream(cam: int = 0):
    """MJPEG stream — plug directly into an <img src="..."> tag."""
    return StreamingResponse(
        _mjpeg_gen(cam),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-cache"},
    )
