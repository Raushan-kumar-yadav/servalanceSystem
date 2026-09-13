"""
frame_recorder.py
Per-camera MP4 recorder. Writes JPEG frames to a temp folder, then assembles
MP4 via ffmpeg. Auto-checkpoints every MAX_SEGMENT_SECONDS so files appear on
disk regularly even if Python is force-killed.
"""
from __future__ import annotations
import subprocess, threading, time, shutil
from datetime import datetime
from pathlib import Path

_recorders: dict[str, "_FrameRecorder"] = {}
_lock = threading.Lock()

# Stop recording if no frame received for this many seconds
_IDLE_TIMEOUT = 10

# Auto-finalize and start new segment after this many seconds
_MAX_SEGMENT = 120   # 2 minutes → files appear on disk every 2 min max


def _recordings_dir() -> Path:
    try:
        from backend.db import get_setting
        saved = get_setting("recordings_dir", "")
        if saved:
            p = Path(saved)
            p.mkdir(parents=True, exist_ok=True)
            return p
    except Exception:
        pass
    # parents[0]=backend dir, parents[1]=servelanceSystem root
    d = Path(__file__).resolve().parents[1] / "recordings"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _make_filename(cam_id: str) -> str:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe = "".join(c if c.isalnum() else "_" for c in cam_id)
    return f"{safe}_{ts}.mp4"


def _assemble_mp4(tmp_dir: Path, out_path: Path, timestamps: list[float]) -> bool:
    """Run ffmpeg to assemble JPEG frames into MP4. Returns True on success."""
    n = len(list(tmp_dir.glob("frame_*.jpg")))
    if n < 2:
        return False

    if len(timestamps) >= 2:
        duration = timestamps[-1] - timestamps[0]
        fps = max(1.0, min((n - 1) / duration, 30.0)) if duration > 0 else 1.0
    else:
        fps = 1.0

    pattern = str(tmp_dir / "frame_%06d.jpg")
    cmd = [
        "ffmpeg", "-y",
        "-framerate", f"{fps:.3f}",
        "-i", pattern,
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "28",
        "-pix_fmt", "yuv420p",
        str(out_path),
    ]
    print(f"[FrameRecorder] Assembling {n} frames at {fps:.1f}fps -> {out_path.name}", flush=True)
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            print(f"[FrameRecorder] ffmpeg error:\n{result.stderr[-600:]}", flush=True)
            return False
    except Exception as e:
        print(f"[FrameRecorder] ffmpeg exception: {e}", flush=True)
        return False

    if out_path.exists() and out_path.stat().st_size > 10_000:
        print(f"[FrameRecorder] Saved {out_path.name} ({out_path.stat().st_size//1024} KB)", flush=True)
        return True
    return False


class _FrameRecorder:
    """Saves JPEG frames to temp dir, assembles MP4 periodically."""

    def __init__(self, cam_id: str):
        self.cam_id   = cam_id
        self._lock    = threading.Lock()
        self._stopped = False
        self._start_new_segment()

        # Watchdog: idle + max-duration checker
        t = threading.Thread(target=self._watchdog, daemon=True)
        t.start()

    def _start_new_segment(self):
        """Initialize a fresh segment (temp dir + counters)."""
        import tempfile
        self.filename    = _make_filename(self.cam_id)
        self.out_path    = _recordings_dir() / self.filename
        self._tmp_dir    = Path(tempfile.mkdtemp(prefix=f"surv_{self.cam_id[:8]}_"))
        self._frame_n    = 0
        self._timestamps: list[float] = []
        self._seg_start  = time.time()
        self.last_ts     = time.time()
        print(f"[FrameRecorder] Started {self.cam_id} -> {self.filename}", flush=True)

    def write(self, jpeg_bytes: bytes) -> None:
        with self._lock:
            if self._stopped:
                return
            self.last_ts = time.time()
            self._timestamps.append(self.last_ts)
            idx = self._frame_n
            self._frame_n += 1

        try:
            (self._tmp_dir / f"frame_{idx:06d}.jpg").write_bytes(jpeg_bytes)
        except Exception as e:
            print(f"[FrameRecorder] write error: {e}", flush=True)

    def _finalize_segment(self) -> str | None:
        """Assemble current segment to MP4, clean temp dir. Returns filename."""
        tmp   = self._tmp_dir
        out   = self.out_path
        times = list(self._timestamps)
        n     = self._frame_n

        if n < 2:
            shutil.rmtree(tmp, ignore_errors=True)
            return None

        ok = _assemble_mp4(tmp, out, times)
        shutil.rmtree(tmp, ignore_errors=True)

        if ok:
            threading.Thread(target=self._index, args=(out.name,), daemon=True).start()
            return out.name
        else:
            try: out.unlink(missing_ok=True)
            except Exception: pass
            return None

    def stop(self) -> str | None:
        with self._lock:
            if self._stopped:
                return None
            self._stopped = True
        return self._finalize_segment()

    def _checkpoint(self):
        """Finalize current segment and immediately start a new one."""
        print(f"[FrameRecorder] Checkpointing {self.cam_id} (max duration reached)", flush=True)
        with self._lock:
            old_tmp   = self._tmp_dir
            old_out   = self.out_path
            old_times = list(self._timestamps)
            old_n     = self._frame_n

        # Start new segment FIRST so frames continue to flow
        with self._lock:
            self._start_new_segment()

        # Assemble old segment in background thread
        def _do_assemble():
            ok = _assemble_mp4(old_tmp, old_out, old_times)
            shutil.rmtree(old_tmp, ignore_errors=True)
            if ok:
                self._index(old_out.name)
            else:
                try: old_out.unlink(missing_ok=True)
                except Exception: pass

        threading.Thread(target=_do_assemble, daemon=True).start()

    def _watchdog(self):
        while not self._stopped:
            time.sleep(5)
            now = time.time()

            # Max segment duration → checkpoint
            if now - self._seg_start >= _MAX_SEGMENT:
                self._checkpoint()
                continue

            # Idle timeout → stop recording entirely
            if now - self.last_ts > _IDLE_TIMEOUT:
                print(f"[FrameRecorder] Idle timeout for {self.cam_id}", flush=True)
                fname = self.stop()
                with _lock:
                    _recorders.pop(self.cam_id, None)
                break

    def _index(self, filename: str):
        time.sleep(2)
        try:
            from backend.routers.recordings import _index_file
            _index_file(filename)
        except Exception as e:
            print(f"[FrameRecorder] Index error: {e}", flush=True)


# ── Public API ──────────────────────────────────────────────────────────────────

def on_frame(cam_id: str, jpeg_bytes: bytes) -> None:
    with _lock:
        rec = _recorders.get(cam_id)
        if rec is None or rec._stopped:
            rec = _FrameRecorder(cam_id)
            _recorders[cam_id] = rec
    rec.write(jpeg_bytes)


def stop_camera(cam_id: str) -> str | None:
    with _lock:
        rec = _recorders.pop(cam_id, None)
    if rec:
        return rec.stop()
    return None


def stop_all() -> list[str]:
    with _lock:
        recs = list(_recorders.values())
        _recorders.clear()
    return [f for r in recs if (f := r.stop())]


def active_cameras() -> list[str]:
    with _lock:
        return [cid for cid, r in _recorders.items() if not r._stopped]
