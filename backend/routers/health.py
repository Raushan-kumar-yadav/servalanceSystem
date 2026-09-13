from fastapi import APIRouter

router = APIRouter(prefix="/health", tags=["health"])

@router.get("")
async def health_check():
    """Basic health check — confirms the backend is running."""
    return {"status": "ok", "service": "servelance-backend"}
