"""Public browser entry links for the desktop's supported navigation routes."""

from urllib.parse import quote, urlencode

from app.core.config import settings
from app.schemas.wework_navigation import validate_wework_url


def browser_link(destination: str) -> str:
    """Keep IM messages clickable without relying on custom-scheme detection."""
    destination = validate_wework_url(destination)
    base = settings.FRONTEND_URL.rstrip("/")
    query = urlencode({"destination": destination})
    return f"{base}/launch/wework?{query}"


def runtime_task_url(device_id: str, task_id: str) -> str:
    """Encode device and task identifiers independently for the desktop router."""
    return validate_wework_url(
        f"wework://tasks/{quote(device_id, safe='')}/{quote(task_id, safe='')}"
    )
