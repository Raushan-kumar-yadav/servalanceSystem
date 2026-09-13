"""
inference.py  —  YOLO11 Pose Estimation endpoint.

POST  /inference/pose     — accepts JPEG frame, returns annotated JPEG
GET   /inference/status   — model load status
POST  /inference/load     — pre-warm the model
"""
from __future__ import annotations

import io
import time
import threading
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from fastapi import APIRouter, UploadFile, File, Form, Response

router = APIRouter(prefix="/inference", tags=["inference"])

# ── Model paths ───────────────────────────────────────────────────────────────
_MODEL_DIR  = Path(r"E:\nsut\dataset\YOLO11-pose-thermal-visual\YOLO11-pose-thermal-visual")
_MODEL_FILE = _MODEL_DIR / "yolo11s-pose.pt"   # s = fast enough for RTX 3050 real-time

# ── Lazy-loaded model (loaded once on first request) ──────────────────────────
_model      = None
_model_lock = threading.Lock()
_load_error: Optional[str] = None
_last_fps   = 0.0
_frame_times: list[float] = []


def _get_model():
    """Load model on first call; subsequent calls return cached instance."""
    global _model, _load_error
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:       # double-check after lock
            return _model
        try:
            from ultralytics import YOLO
            import torch
            print(f"[inference] Loading {_MODEL_FILE.name} …", flush=True)
            m = YOLO(str(_MODEL_FILE))
            # Warm up on a dummy frame so first real request is fast
            dummy = np.zeros((640, 640, 3), dtype=np.uint8)
            device = 0 if torch.cuda.is_available() else "cpu"
            m.predict(dummy, device=device, verbose=False, imgsz=640)
            _model = m
            print(f"[inference] Model ready on device={device}", flush=True)
        except Exception as e:
            _load_error = str(e)
            print(f"[inference] ERROR loading model: {e}", flush=True)
    return _model


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/status")
def status():
    """Return model load status and last FPS."""
    return {
        "loaded":     _model is not None,
        "model":      _MODEL_FILE.name,
        "error":      _load_error,
        "fps":        round(_last_fps, 1),
    }


@router.post("/load")
async def load_model():
    """Pre-warm the model (call on app startup to avoid cold-start lag)."""
    import asyncio, concurrent.futures
    loop = asyncio.get_event_loop()
    with concurrent.futures.ThreadPoolExecutor() as pool:
        await loop.run_in_executor(pool, _get_model)
    return {"ok": _model is not None, "error": _load_error}


@router.post("/pose")
async def infer_pose(file: UploadFile = File(...)):
    """
    Accept a JPEG frame (multipart/form-data 'file' field),
    run YOLO11 pose estimation, return annotated JPEG.
    """
    global _last_fps, _frame_times

    t0 = time.perf_counter()

    # ── Decode incoming frame ─────────────────────────────────────────────────
    raw  = await file.read()
    arr  = np.frombuffer(raw, np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)

    if frame is None:
        return Response(status_code=400, content="Could not decode image")

    # ── Load / get model ──────────────────────────────────────────────────────
    model = _get_model()
    if model is None:
        # Model not loaded — return original frame with error banner
        cv2.putText(frame, f"Model error: {_load_error}",
                    (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
        _, jpeg = cv2.imencode(".jpg", frame)
        return Response(content=jpeg.tobytes(), media_type="image/jpeg")

    # ── Inference ─────────────────────────────────────────────────────────────
    import torch
    device = 0 if torch.cuda.is_available() else "cpu"

    results = model.predict(
        frame,
        device    = device,
        imgsz     = 640,
        conf      = 0.35,          # confidence threshold
        iou       = 0.45,
        verbose   = False,
        stream    = False,
    )

    # ── Render annotated frame ────────────────────────────────────────────────
    annotated = results[0].plot(
        conf      = True,
        line_width= 2,
        font_size = 0.5,
    )

    # ── FPS tracking ──────────────────────────────────────────────────────────
    t1 = time.perf_counter()
    _frame_times.append(t1)
    _frame_times = [t for t in _frame_times if t > t1 - 1.0]  # keep last 1s
    _last_fps = len(_frame_times)

    # ── Draw FPS + person count on frame ─────────────────────────────────────
    n_persons = len(results[0].boxes) if results[0].boxes is not None else 0
    ms        = int((t1 - t0) * 1000)

    cv2.putText(annotated,
                f"{_last_fps} FPS  |  {ms}ms  |  {n_persons} person(s)",
                (10, annotated.shape[0] - 12),
                cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                (200, 255, 200), 1, cv2.LINE_AA)

    # ── Encode & return ───────────────────────────────────────────────────────
    _, out_jpeg = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 82])
    return Response(content=out_jpeg.tobytes(), media_type="image/jpeg")

