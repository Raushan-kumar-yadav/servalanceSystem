"""
detection.py  â€”  Full Surveillance Detection Pipeline
======================================================
Pipeline per frame:
  1. Thermal YOLO (best.pt)  â†’  detect persons / threats
  2. Pose model (yolo11s-pose.pt)  â†’  skeleton keypoints
  3. Activity classifier  â†’  what are they doing
  4. ReID buffer  â†’  assign persistent IDs across cameras
  5. SSE stream  â†’  push DetectionEvent JSON to UI widget

GET  /detection/stream/{cam_id}    SSE stream of detection events
POST /detection/frame/{cam_id}     process JPEG frame, return annotated JPEG + JSON header
GET  /detection/persons            current persons buffer (all cameras)
GET  /detection/status             model load status
"""
from __future__ import annotations
import io, time, threading, json, math
from pathlib import Path
from typing import Optional
from collections import deque

import cv2
import numpy as np
from fastapi import APIRouter, UploadFile, File, Response
from fastapi.responses import StreamingResponse

router = APIRouter(prefix="/detection", tags=["detection"])

# ── Model Paths (portable — falls back to standard pose model) ───────────────
_THERMAL_MODEL_PATH = Path(r"E:\servelanceSystem\AI\yoloModels\thermal_partial_10k_weights\best.pt")

# Standard pose model — search common locations, auto-download if missing
_POSE_CANDIDATES = [
    Path(r"E:\nsut\dataset\YOLO11-pose-thermal-visual\YOLO11-pose-thermal-visual\yolo11s-pose.pt"),
    Path(__file__).resolve().parents[2] / "AI" / "models" / "yolo11s-pose.pt",
    Path(__file__).resolve().parents[2] / "yolo11s-pose.pt",
    Path("yolo11s-pose.pt"),
]
def _resolve_pose_path() -> Path:
    for p in _POSE_CANDIDATES:
        if p.exists():
            return p
    return Path("yolo11s-pose.pt")   # ultralytics auto-download fallback

_POSE_MODEL_PATH = _resolve_pose_path()

# ── Lazy Models ───────────────────────────────────────────────────────────────
_thermal_model = None
_pose_model    = None
_model_lock    = threading.Lock()
_load_error: Optional[str] = None

def _get_models():
    global _thermal_model, _pose_model, _load_error
    if _pose_model is not None:
        return _thermal_model, _pose_model
    with _model_lock:
        if _pose_model is not None:
            return _thermal_model, _pose_model
        try:
            from ultralytics import YOLO
            import torch
            device = 0 if torch.cuda.is_available() else "cpu"

            # Try thermal model (optional — only on dev machine with dataset)
            if _THERMAL_MODEL_PATH.exists():
                print(f"[Detection] Loading thermal model: {_THERMAL_MODEL_PATH.name}", flush=True)
                tm = YOLO(str(_THERMAL_MODEL_PATH))
                dummy = np.zeros((640, 640, 3), dtype=np.uint8)
                tm.predict(dummy, device=device, verbose=False, imgsz=640)
                _thermal_model = tm
            else:
                print(f"[Detection] Thermal model not found — skipping (using pose-only mode)", flush=True)

            # Pose model is REQUIRED
            print(f"[Detection] Loading pose model: {_POSE_MODEL_PATH.name}", flush=True)
            pm = YOLO(str(_POSE_MODEL_PATH))
            dummy = np.zeros((640, 640, 3), dtype=np.uint8)
                pm = YOLO(str(_POSE_MODEL_PATH))
                pm.predict(dummy, device=device, verbose=False, imgsz=640)
                _pose_model = pm

            print(f"[Detection] Models ready on device={device}", flush=True)
        except Exception as e:
            _load_error = str(e)
            print(f"[Detection] Model load error: {e}", flush=True)
    return _thermal_model, _pose_model


# â”€â”€ Activity Classifier (rule-based on keypoints) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

_COCO_KP = [
    "nose","left_eye","right_eye","left_ear","right_ear",
    "left_shoulder","right_shoulder","left_elbow","right_elbow",
    "left_wrist","right_wrist","left_hip","right_hip",
    "left_knee","right_knee","left_ankle","right_ankle",
]
_KP_IDX = {n: i for i, n in enumerate(_COCO_KP)}

def _kp(kps: np.ndarray, name: str) -> Optional[np.ndarray]:
    """Return (x,y,conf) for a named keypoint or None if not visible."""
    i = _KP_IDX.get(name)
    if i is None or i >= len(kps):
        return None
    k = kps[i]
    return k if k[2] > 0.3 else None

def _dist(a, b) -> float:
    if a is None or b is None:
        return float("inf")
    return math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2)

def classify_activity(kps: np.ndarray, bbox_h: float) -> tuple[str, float]:
    """
    Returns (activity_label, threat_score 0-1).
    Uses simple heuristics on keypoint geometry.
    """
    if kps is None or len(kps) < 17:
        return "unknown", 0.1

    ls  = _kp(kps, "left_shoulder");  rs  = _kp(kps, "right_shoulder")
    lh  = _kp(kps, "left_hip");       rh  = _kp(kps, "right_hip")
    lk  = _kp(kps, "left_knee");      rk  = _kp(kps, "right_knee")
    la  = _kp(kps, "left_ankle");     ra  = _kp(kps, "right_ankle")
    lw  = _kp(kps, "left_wrist");     rw  = _kp(kps, "right_wrist")
    nose= _kp(kps, "nose")

    shoulder_y = np.mean([k[1] for k in [ls, rs] if k is not None]) if any([ls, rs]) else None
    hip_y      = np.mean([k[1] for k in [lh, rh] if k is not None]) if any([lh, rh]) else None
    ankle_y    = np.mean([k[1] for k in [la, ra] if k is not None]) if any([la, ra]) else None
    knee_y     = np.mean([k[1] for k in [lk, rk] if k is not None]) if any([lk, rk]) else None

    body_h = bbox_h if bbox_h > 0 else 100.0

    # â”€â”€ Running: ankles moving, knees bent, high arm swing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    arm_spread = _dist(lw, rw) / body_h if (lw is not None and rw is not None) else 0
    knees_bent = False
    if knee_y and hip_y and ankle_y:
        knees_bent = (ankle_y - knee_y) / body_h < 0.18

    # â”€â”€ Crouching: hip close to knee height â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    crouching = False
    if hip_y and knee_y and body_h > 0:
        crouching = abs(hip_y - knee_y) / body_h < 0.15

    # â”€â”€ Lying / on ground â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    lying = False
    if shoulder_y and ankle_y and body_h > 0:
        lying = abs(shoulder_y - ankle_y) / body_h < 0.25

    # â”€â”€ Raising arms (hands above shoulders) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    arms_raised = False
    if shoulder_y and lw is not None and rw is not None:
        arms_raised = (lw[1] < shoulder_y - 0.1*body_h) or (rw[1] < shoulder_y - 0.1*body_h)

    # â”€â”€ Classify â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if lying:
        return "lying down", 0.55
    if crouching:
        return "crouching", 0.65   # suspicious
    if arms_raised:
        return "hands raised", 0.4
    if knees_bent and arm_spread > 0.3:
        return "running", 0.35
    if shoulder_y and hip_y and body_h > 0:
        torso_ratio = abs(shoulder_y - hip_y) / body_h
        if torso_ratio < 0.15:
            return "bent over", 0.5
    return "standing", 0.1


# â”€â”€ Cross-camera Person ReID Buffer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

class PersonBuffer:
    """
    Maintains a rolling buffer of person appearances across all cameras.
    A 'signature' is: (bbox_aspect, keypoint_spread, height_fraction).
    Persons with matching signatures within threshold are given the same global ID.
    """
    def __init__(self, max_age_sec=30, sim_threshold=0.15):
        self._persons: dict[str, dict] = {}   # person_id â†’ info
        self._lock = threading.Lock()
        self._max_age = max_age_sec
        self._sim_th  = sim_threshold
        self._counter = 0

    def _signature(self, bbox, kps, frame_shape) -> np.ndarray:
        """Compact 8-D feature vector from bbox + pose."""
        fh, fw = frame_shape[:2]
        x1,y1,x2,y2 = bbox
        w = (x2-x1)/fw;  h = (y2-y1)/fh
        cx = ((x1+x2)/2)/fw;  cy = ((y1+y2)/2)/fh
        aspect = w/(h+1e-6)
        kp_spread = 0.0
        if kps is not None and len(kps) >= 17:
            vis = [k for k in kps if k[2] > 0.3]
            if len(vis) > 2:
                xs = [k[0]/fw for k in vis]; ys = [k[1]/fh for k in vis]
                kp_spread = (max(xs)-min(xs)) + (max(ys)-min(ys))
        return np.array([cx, cy, w, h, aspect, kp_spread, w*h, h/max(w,1e-6)])

    def _dist(self, a: np.ndarray, b: np.ndarray) -> float:
        # Weighted L2 ignoring position (cx,cy) for cross-camera match
        wa = np.array([0.0, 0.0, 1.0, 1.5, 1.5, 1.0, 1.2, 1.0])
        diff = (a - b) * wa
        return float(np.sqrt((diff**2).sum()))

    def match_or_create(self, cam_id: str, bbox, kps, frame_shape, conf: float) -> str:
        """Return a persistent person_id for this detection."""
        now = time.time()
        sig = self._signature(bbox, kps, frame_shape)
        with self._lock:
            # Expire old entries
            expired = [pid for pid, p in self._persons.items()
                       if now - p["last_seen"] > self._max_age]
            for pid in expired:
                del self._persons[pid]

            # Find best match (only across OTHER cameras for same-camera just reuse recent)
            best_pid, best_dist = None, float("inf")
            for pid, p in self._persons.items():
                if p["cam_id"] == cam_id and (now - p["last_seen"]) < 2.0:
                    # Same camera, very recent â†’ definitely same person
                    d = self._dist(sig, p["sig"])
                    if d < best_dist:
                        best_dist = d; best_pid = pid
                elif p["cam_id"] != cam_id:
                    d = self._dist(sig, p["sig"])
                    if d < best_dist:
                        best_dist = d; best_pid = pid

            if best_pid and best_dist < self._sim_th:
                self._persons[best_pid].update({
                    "last_seen": now, "cam_id": cam_id,
                    "sig": sig, "conf": conf,
                })
                return best_pid

            # New person
            self._counter += 1
            pid = f"P{self._counter:03d}"
            self._persons[pid] = {
                "pid": pid, "cam_id": cam_id, "sig": sig,
                "conf": conf, "first_seen": now, "last_seen": now,
            }
            return pid

    def snapshot(self) -> list[dict]:
        now = time.time()
        with self._lock:
            return [
                {
                    "pid": v["pid"],
                    "cam_id": v["cam_id"],
                    "conf": round(v["conf"], 3),
                    "age_sec": round(now - v["first_seen"], 1),
                    "last_seen_sec": round(now - v["last_seen"], 1),
                }
                for v in self._persons.values()
                if now - v["last_seen"] < self._max_age
            ]

_reid_buffer = PersonBuffer(max_age_sec=30, sim_threshold=0.18)


# â”€â”€ Per-camera SSE event queue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# cam_id â†’ deque of JSON-serializable dicts
_event_queues: dict[str, deque] = {}
_eq_lock = threading.Lock()
_fps_tracker: dict[str, list] = {}

def _push_event(cam_id: str, event: dict):
    with _eq_lock:
        if cam_id not in _event_queues:
            _event_queues[cam_id] = deque(maxlen=60)
        _event_queues[cam_id].append(event)

def _pop_events(cam_id: str) -> list[dict]:
    with _eq_lock:
        q = _event_queues.get(cam_id, deque())
        events = list(q)
        q.clear()
        return events


# â”€â”€ Core Processing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def _process_frame(cam_id: str, frame: np.ndarray) -> tuple[np.ndarray, dict]:
    """
    Run full pipeline on a frame. Returns (annotated_frame, event_dict).
    """
    import torch
    thermal_model, pose_model = _get_models()
    if pose_model is None:
        cv2.putText(frame, f"Model error: {_load_error}", (10,30),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0,0,255), 2)
        return frame, {"error": _load_error}

    device = 0 if torch.cuda.is_available() else "cpu"
    h, w = frame.shape[:2]

    # â”€â”€ Stage 1: Thermal YOLO detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    det_results = thermal_model.predict(
        frame, device=device, imgsz=640, conf=0.30, iou=0.45,
        verbose=False, stream=False,
    )
    det = det_results[0]
    boxes      = det.boxes.xyxy.cpu().numpy()   if det.boxes  is not None else np.zeros((0,4))
    confs      = det.boxes.conf.cpu().numpy()   if det.boxes  is not None else np.zeros(0)
    class_ids  = det.boxes.cls.cpu().numpy().astype(int) if det.boxes is not None else np.zeros(0,int)
    class_names= thermal_model.names

    # â”€â”€ Stage 2: Pose on each detected person â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    persons_data: list[dict] = []
    annotated = frame.copy()

    for i, (box, conf, cls_id) in enumerate(zip(boxes, confs, class_ids)):
        x1,y1,x2,y2 = box.astype(int)
        cls_name = class_names.get(cls_id, str(cls_id))
        bbox_h   = y2 - y1

        # Pose estimation on the person crop
        kps = None
        activity, threat_score = "unknown", float(conf) * 0.5

        if pose_model is not None and cls_name.lower() in ("person","human","0"):
            # Expand crop slightly
            pad = int(bbox_h * 0.1)
            cx1 = max(0, x1-pad); cy1 = max(0, y1-pad)
            cx2 = min(w, x2+pad); cy2 = min(h, y2+pad)
            crop = frame[cy1:cy2, cx1:cx2]
            if crop.size > 0:
                pose_res = pose_model.predict(
                    crop, device=device, imgsz=320, conf=0.25,
                    verbose=False, stream=False,
                )
                if pose_res[0].keypoints is not None:
                    kp_data = pose_res[0].keypoints.data.cpu().numpy()
                    if len(kp_data) > 0:
                        kps = kp_data[0]
                        # Remap kp coords back to full frame
                        kps[:, 0] += cx1; kps[:, 1] += cy1
                        activity, activity_threat = classify_activity(kps, bbox_h)
                        threat_score = max(float(conf) * 0.4, activity_threat)

        # ReID
        pid = _reid_buffer.match_or_create(cam_id, box, kps, frame.shape, float(conf))

        # Threat colour: greenâ†’yellowâ†’red
        t = threat_score
        color = (
            int(min(255, t * 2 * 255)),
            int(max(0, 255 - t * 2 * 255)),
            0
        )

        # Draw bbox
        cv2.rectangle(annotated, (x1,y1), (x2,y2), color, 2)

        # Draw keypoints
        if kps is not None:
            for k in kps:
                if k[2] > 0.3:
                    cv2.circle(annotated, (int(k[0]), int(k[1])), 3, (100,220,255), -1)

        # Label
        label = f"{pid} | {cls_name} {conf:.0%} | {activity}"
        threat_label = f"âš  {int(threat_score*100)}%"
        lx, ly = x1, max(y1-8, 14)
        cv2.rectangle(annotated, (x1, ly-14), (x1+len(label)*8+4, ly+4), (0,0,0), -1)
        cv2.putText(annotated, label, (x1+2, ly), cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1, cv2.LINE_AA)
        cv2.putText(annotated, threat_label, (x2-60, y1+16), cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1)

        persons_data.append({
            "pid": pid,
            "class": cls_name,
            "conf": round(float(conf), 3),
            "activity": activity,
            "threat_score": round(threat_score, 3),
            "bbox": [int(x1), int(y1), int(x2), int(y2)],
        })

    # â”€â”€ FPS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    now = time.time()
    if cam_id not in _fps_tracker:
        _fps_tracker[cam_id] = []
    _fps_tracker[cam_id].append(now)
    _fps_tracker[cam_id] = [t for t in _fps_tracker[cam_id] if t > now-1.0]
    fps = len(_fps_tracker[cam_id])

    max_threat = max((p["threat_score"] for p in persons_data), default=0.0)
    alert = max_threat >= 0.6

    # Overlay HUD
    hud = f"Cam:{cam_id[:8]} | {fps}FPS | {len(persons_data)} person(s) | Threat:{int(max_threat*100)}%"
    cv2.rectangle(annotated, (0, h-24), (w, h), (0,0,0), -1)
    cv2.putText(annotated, hud, (8, h-7), cv2.FONT_HERSHEY_SIMPLEX, 0.48,
                (0,0,200) if alert else (160,255,160), 1, cv2.LINE_AA)
    if alert:
        cv2.rectangle(annotated, (0,0), (w-1,h-1), (0,0,220), 3)

    event = {
        "cam_id":      cam_id,
        "ts":          now,
        "fps":         fps,
        "persons":     persons_data,
        "max_threat":  round(max_threat, 3),
        "alert":       alert,
        "person_count":len(persons_data),
    }
    _push_event(cam_id, event)

    # â”€â”€ Telegram alert (background thread, cooldown-gated) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if alert and persons_data:
        try:
            from backend.telegram_notifier import notify_threat
            notify_threat(cam_id, persons_data, max_threat)
        except Exception as _tg_err:
            pass   # Telegram config missing â†’ silent

    return annotated, event


# â”€â”€ API Endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@router.get("/status")
def status():
    tm, pm = _thermal_model, _pose_model
    return {
        "thermal_model": {
            "loaded": tm is not None,
            "path":   str(_THERMAL_MODEL_PATH),
        },
        "pose_model": {
            "loaded": pm is not None,
            "path":   str(_POSE_MODEL_PATH),
        },
        "error":    _load_error,
        "persons":  len(_reid_buffer.snapshot()),
    }


@router.post("/load")
async def load_models():
    import asyncio, concurrent.futures
    loop = asyncio.get_event_loop()
    with concurrent.futures.ThreadPoolExecutor() as pool:
        await loop.run_in_executor(pool, _get_models)
    return {"ok": _thermal_model is not None, "error": _load_error}


@router.post("/frame/{cam_id}")
async def process_frame(cam_id: str, file: UploadFile = File(...)):
    """Process one JPEG frame through the full pipeline. Returns annotated JPEG."""
    raw   = await file.read()
    arr   = np.frombuffer(raw, np.uint8)
    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if frame is None:
        return Response(status_code=400, content="Cannot decode image")

    annotated, event = _process_frame(cam_id, frame)
    _, jpeg = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 82])

    # ── Record annotated frame (all cameras go through here) ──────────────────
    try:
        from backend.frame_recorder import on_frame as _rec_frame
        _rec_frame(cam_id, jpeg.tobytes())
    except Exception:
        pass

    # Return annotated JPEG; event is also pushed to SSE queue
    resp = Response(content=jpeg.tobytes(), media_type="image/jpeg")
    resp.headers["X-Detection-Event"] = json.dumps(event)
    return resp



@router.get("/events/{cam_id}")
async def sse_events(cam_id: str):
    """
    Server-Sent Events stream for the detection widget.
    Polls the event queue for this camera at 5 Hz.
    """
    async def gen():
        while True:
            import asyncio
            events = _pop_events(cam_id)
            for ev in events:
                yield f"data: {json.dumps(ev)}\n\n"
            if not events:
                # heartbeat every 2s
                yield f": ping\n\n"
            await asyncio.sleep(0.2)
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control":"no-cache","X-Accel-Buffering":"no"})


@router.get("/persons")
def get_persons():
    """Return all currently tracked persons across all cameras."""
    return {"persons": _reid_buffer.snapshot()}


@router.get("/telegram/status")
def telegram_status():
    """Check whether Telegram credentials are configured."""
    try:
        from backend.telegram_notifier import is_configured, _bot_token, _chat_id, _threshold, _cooldown
        return {
            "configured":  is_configured(),
            "bot_token_set": bool(_bot_token()),
            "chat_id_set":   bool(_chat_id()),
            "threshold":     _threshold(),
            "cooldown_sec":  _cooldown(),
        }
    except Exception as e:
        return {"configured": False, "error": str(e)}


@router.post("/telegram/test")
def telegram_test():
    """Send a test Telegram message to verify credentials."""
    try:
        from backend.telegram_notifier import test_connection, _send_telegram
        result = test_connection()
        if result["ok"]:
            _send_telegram(
                "âœ… <b>ServelanceSystem Connected</b>\n"
                "Telegram alerts are working. You will receive threat notifications here."
            )
        return result
    except Exception as e:
        return {"ok": False, "error": str(e)}

