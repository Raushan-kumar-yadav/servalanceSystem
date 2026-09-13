"""
Recordings router — start/stop MP4 recording per camera, auto-index after stop.
"""
from __future__ import annotations
import threading
import subprocess
import time
from datetime import datetime
from pathlib import Path
from fastapi import APIRouter, HTTPException

recordings_router = APIRouter(prefix="/recordings", tags=["recordings"])

# ── State ─────────────────────────────────────────────────────────────────────
_active: dict[str, dict] = {}   # cam_id -> {process, filename, start_time}
_index_queue: list[str]  = []   # filenames pending indexing
_lock = threading.Lock()


def _recordings_dir() -> Path:
    from backend.db import get_setting
    saved = get_setting("recordings_dir", "")
    if saved and Path(saved).exists():
        return Path(saved)
    default = Path(__file__).resolve().parents[2] / "recordings"
    default.mkdir(parents=True, exist_ok=True)
    return default


def _make_filename(cam_id: str) -> str:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"{cam_id}_{ts}.mp4"


# ── Auto-start on camera connect (called from mobile router) ──────────────────

def auto_start_recording(cam_id: str, stream_url: str) -> None:
    """Called automatically when a mobile camera connects."""
    with _lock:
        if cam_id in _active:
            return   # already recording
    start_recording_internal(cam_id, stream_url)


def stop_recording_internal(cam_id: str) -> str | None:
    """Stop recording and enqueue for indexing. Returns filename or None."""
    with _lock:
        info = _active.pop(cam_id, None)
    if not info:
        return None
    proc: subprocess.Popen = info["process"]
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()
    filename = info["filename"]
    _index_queue.append(filename)
    # Start indexing in background
    threading.Thread(target=_index_file, args=(filename,), daemon=True).start()
    print(f"[Recordings] Stopped {cam_id} → {filename}", flush=True)
    return filename


def start_recording_internal(cam_id: str, stream_url: str) -> str:
    """Start ffmpeg recording of stream_url to MP4. Returns filename."""
    rec_dir  = _recordings_dir()
    filename = _make_filename(cam_id)
    out_path = rec_dir / filename

    cmd = [
        "ffmpeg", "-y",
        "-i", stream_url,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
        "-c:a", "aac",
        "-movflags", "+faststart",
        str(out_path),
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with _lock:
        _active[cam_id] = {
            "process":    proc,
            "filename":   filename,
            "start_time": datetime.now().isoformat(),
        }
    print(f"[Recordings] Started {cam_id} → {filename}", flush=True)
    return filename


# ── Indexing pipeline ─────────────────────────────────────────────────────────

def _index_file(filename: str) -> None:
    """Index a recording file after it stops. Runs in background thread."""
    rec_dir  = _recordings_dir()
    filepath = rec_dir / filename
    if not filepath.exists():
        print(f"[Recordings] File not found for indexing: {filepath}", flush=True)
        return

    print(f"[Recordings] Indexing {filename}…", flush=True)
    try:
        from backend.ai.VideoSemantic.indexer     import index_video, is_asset_indexed
        from backend.ai.VideoSemantic.frameExtractor import extract_keyframes, get_video_duration
        from backend.ai.VideoSemantic.descriptions   import describe_frames

        recording_id = filepath.stem
        if is_asset_indexed(recording_id):
            print(f"[Recordings] Already indexed: {recording_id}", flush=True)
            return

        # Parse cam_id and date from filename  e.g. mob1_20240913_143022
        parts  = recording_id.split("_")
        cam_id = parts[0] if parts else "unknown"
        date   = f"{parts[1][:4]}-{parts[1][4:6]}-{parts[1][6:]}" if len(parts) > 1 and len(parts[1]) == 8 else datetime.now().date().isoformat()

        # Extract frames every 30s
        frames = extract_keyframes(str(filepath), every_n_seconds=30, max_frames=40)
        if not frames:
            print(f"[Recordings] No frames extracted from {filename}", flush=True)
            return

        # Get descriptions
        descs = describe_frames(frames, cam_id=cam_id, every_n_seconds=30)

        # Build chunks with metadata
        chunks = [
            {**d, "cam_id": cam_id, "date": date}
            for d in descs
        ]

        index_video(recording_id, chunks)

        # Cleanup temp frames
        import os
        for f in frames:
            try: os.unlink(f)
            except Exception: pass

        if filename in _index_queue:
            _index_queue.remove(filename)

    except Exception as e:
        import traceback; traceback.print_exc()
        print(f"[Recordings] Indexing error for {filename}: {e}", flush=True)


# ── API endpoints ─────────────────────────────────────────────────────────────

@recordings_router.get("/status")
def recording_status():
    with _lock:
        active_cams = {
            cam: {"filename": info["filename"], "start_time": info["start_time"]}
            for cam, info in _active.items()
        }
    return {
        "active":      len(active_cams),
        "cameras":     active_cams,
        "index_queue": len(_index_queue),
        "queued":      list(_index_queue),
    }


@recordings_router.post("/start/{cam_id}")
def start_recording_api(cam_id: str, stream_url: str = ""):
    if not stream_url:
        stream_url = f"http://127.0.0.1:8000/mobile/stream/{cam_id}"
    filename = start_recording_internal(cam_id, stream_url)
    return {"ok": True, "filename": filename, "cam_id": cam_id}


@recordings_router.post("/stop/{cam_id}")
def stop_recording_api(cam_id: str):
    filename = stop_recording_internal(cam_id)
    if not filename:
        raise HTTPException(404, f"No active recording for '{cam_id}'")
    return {"ok": True, "filename": filename, "indexing": True}


@recordings_router.get("/list")
def list_recordings_api(date: str = ""):
    rec_dir = _recordings_dir()
    files   = sorted(rec_dir.glob("*.mp4"), key=lambda f: f.stat().st_mtime, reverse=True)
    if date:
        files = [f for f in files if date.replace("-", "") in f.stem]
    result = []
    for f in files[:100]:
        parts  = f.stem.split("_")
        cam_id = parts[0] if parts else "?"
        result.append({
            "filename":   f.name,
            "cam_id":     cam_id,
            "size_mb":    round(f.stat().st_size / (1024 * 1024), 2),
            "modified":   datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
            "indexed":    False,   # TODO: check ChromaDB
        })
    return {"recordings": result, "dir": str(rec_dir)}


@recordings_router.post("/index/{filename}")
def trigger_index(filename: str):
    """Manually trigger indexing for a recording file."""
    rec_dir  = _recordings_dir()
    filepath = rec_dir / filename
    if not filepath.exists():
        raise HTTPException(404, f"File not found: {filename}")
    _index_queue.append(filename)
    threading.Thread(target=_index_file, args=(filename,), daemon=True).start()
    return {"ok": True, "message": f"Indexing started for {filename}"}


@recordings_router.get("/dir")
def get_recordings_dir():
    return {"dir": str(_recordings_dir())}


@recordings_router.post("/dir")
def set_recordings_dir(path: str):
    from backend.db import set_setting
    p = Path(path)
    if not p.exists():
        try:
            p.mkdir(parents=True)
        except Exception as e:
            raise HTTPException(400, f"Cannot create directory: {e}")
    set_setting("recordings_dir", str(p))
    return {"ok": True, "dir": str(p)}


@recordings_router.get("/serve/{filename}")
def serve_recording(filename: str):
    """Serve an MP4 for in-browser video playback."""
    from fastapi.responses import FileResponse
    rec_dir  = _recordings_dir()
    filepath = rec_dir / filename
    if not filepath.exists():
        raise HTTPException(404, "Recording not found")
    return FileResponse(str(filepath), media_type="video/mp4")


@recordings_router.post("/search")
def search_clips(query: str, top_k: int = 8, date: str = ""):
    """Natural-language clip search. Returns matching segments with timestamps."""
    try:
        from backend.ai.VideoSemantic.indexer import search_videos
        hits = search_videos(query, top_k=top_k, date_filter=date or None)
        return {"query": query, "hits": hits}
    except Exception as e:
        print(f"[Recordings] Search error: {e}", flush=True)
        return {"query": query, "hits": [], "error": str(e)}


# ── Indexing status tracking ──────────────────────────────────────────────────
_index_status: dict[str, str] = {}   # filename → "pending"|"running"|"done"|"error"


@recordings_router.get("/index-status")
def get_index_status():
    """Return indexing status for all known recordings."""
    try:
        from backend.ai.VideoSemantic.indexer import is_asset_indexed
        rec_dir = _recordings_dir()
        files   = sorted(rec_dir.glob("*.mp4"), key=lambda f: f.stat().st_mtime, reverse=True)
        result  = {}
        for f in files[:50]:
            rid    = f.stem
            status = _index_status.get(f.name, "unknown")
            if status == "unknown":
                try:
                    status = "indexed" if is_asset_indexed(rid) else "unindexed"
                except Exception:
                    status = "unindexed"
            result[f.name] = status
        return {"status": result, "queue_len": len(_index_queue)}
    except Exception as e:
        return {"status": {}, "queue_len": 0, "error": str(e)}


def _index_file_tracked(filename: str) -> None:
    """Wrapper around _index_file that updates _index_status."""
    _index_status[filename] = "running"
    try:
        _index_file(filename)
        _index_status[filename] = "indexed"
    except Exception:
        _index_status[filename] = "error"


@recordings_router.post("/index-all")
def index_all_recordings():
    """Trigger indexing for all un-indexed recordings in the recordings folder."""
    try:
        from backend.ai.VideoSemantic.indexer import is_asset_indexed
        rec_dir   = _recordings_dir()
        files     = list(rec_dir.glob("*.mp4"))
        queued    = []
        for f in files:
            if _index_status.get(f.name) in ("running", "indexed"):
                continue
            try:
                if is_asset_indexed(f.stem):
                    _index_status[f.name] = "indexed"
                    continue
            except Exception:
                pass
            _index_status[f.name] = "pending"
            _index_queue.append(f.name)
            threading.Thread(target=_index_file_tracked, args=(f.name,), daemon=True).start()
            queued.append(f.name)
        return {"ok": True, "queued": queued, "count": len(queued)}
    except Exception as e:
        return {"ok": False, "error": str(e)}
