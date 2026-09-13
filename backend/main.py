from __future__ import annotations
import os, sys, socket, asyncio, uvicorn
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

# ── Routers ──────────────────────────────────────────────────────────────────
from backend.routers import health
from backend.routers import camera
from backend.routers import inference
from backend.routers import mobile
from backend.routers import config as config_router
from backend.db import init_db

# Surveillance AI + recordings routers
try:
    from backend.ai.router import ai_router
    from backend.routers.recordings import recordings_router
    _SURV_AI_LOADED = True
except Exception as _e:
    print(f"[backend] Surveillance AI routers not loaded: {_e}", flush=True)
    _SURV_AI_LOADED = False


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ───────────────────────────────────────────────────────────────
    import platform
    if platform.system() == "Windows":
        loop = asyncio.get_event_loop()
        def _win_exc_handler(lp, ctx):
            if isinstance(ctx.get("exception"), ConnectionResetError):
                return
            lp.default_exception_handler(ctx)
        loop.set_exception_handler(_win_exc_handler)

    init_db()
    mobile.load_cameras_from_db()
    print("[backend] ServelanceSystem backend starting up", flush=True)
    yield
    # ── Shutdown ──────────────────────────────────────────────────────────────
    print("[backend] ServelanceSystem backend shutting down", flush=True)
    try:
        from backend.frame_recorder import stop_all
        saved = stop_all()
        if saved:
            print(f"[backend] Finalized {len(saved)} recording(s): {saved}", flush=True)
    except Exception as e:
        print(f"[backend] shutdown recorder error: {e}", flush=True)


app = FastAPI(title="ServelanceSystem API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Core
app.include_router(health.router)
app.include_router(camera.router)
app.include_router(inference.router)
app.include_router(mobile.router)
app.include_router(config_router.router)

# Surveillance AI + recordings
if _SURV_AI_LOADED:
    app.include_router(ai_router)
    app.include_router(recordings_router)

# Detection pipeline (thermal YOLO + pose + ReID)
try:
    from backend.routers.detection import router as detection_router
    app.include_router(detection_router)
    print("[backend] Detection pipeline router loaded", flush=True)
except Exception as _det_err:
    print(f"[backend] Detection router skipped: {_det_err}", flush=True)


# ── Port detection (Electron reads "starting on port XXXX" from stdout) ───────
_PORT_CACHE = Path(__file__).resolve().parents[1] / ".port_cache"
_PREFERRED_PORT = 8765   # fixed preferred port — phone links stay alive across restarts

def _find_free_port(preferred: int = _PREFERRED_PORT) -> int:
    """Try preferred port first; if taken pick a random free one."""
    for p in [preferred] + list(range(preferred + 1, preferred + 20)):
        try:
            with socket.socket() as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind(("", p))
                return p
        except OSError:
            continue
    # All preferred ports taken — pick any free
    with socket.socket() as s:
        s.bind(("", 0))
        return s.getsockname()[1]

def _load_cached_port() -> int | None:
    """Return last-used port from cache file, or None."""
    try:
        return int(_PORT_CACHE.read_text().strip())
    except Exception:
        return None

def _save_port(port: int) -> None:
    try:
        _PORT_CACHE.write_text(str(port))
    except Exception:
        pass

def _resolve_port() -> int:
    """
    Priority: env PORT → cached port (if still free) → preferred fixed port → random.
    Always saves the chosen port to cache so next restart reuses it.
    """
    if "PORT" in os.environ:
        p = int(os.environ["PORT"])
        _save_port(p)
        return p

    cached = _load_cached_port()
    if cached:
        # Try to bind the cached port
        try:
            with socket.socket() as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind(("", cached))
            _save_port(cached)
            return cached
        except OSError:
            pass  # cached port taken — fall through

    port = _find_free_port()
    _save_port(port)
    return port


if __name__ == "__main__":
    port = _resolve_port()

    # ── Try HTTPS so mobile getUserMedia works (requires secure context) ────────
    ssl_args: dict = {}
    scheme = "http"
    try:
        from backend.ssl_gen import generate_cert
        result = generate_cert()
        if result:
            ssl_args["ssl_certfile"] = result[0]
            ssl_args["ssl_keyfile"]  = result[1]
            scheme = "https"
    except Exception as _ssl_err:
        print(f"[backend] HTTPS unavailable: {_ssl_err}", flush=True)

    # Electron reads this line to extract port AND scheme
    print(f"[backend] starting on port {port} scheme {scheme}", flush=True)

    uvicorn.run(
        "backend.main:app",
        host="0.0.0.0",
        port=port,
        reload=False,
        **ssl_args,
    )
