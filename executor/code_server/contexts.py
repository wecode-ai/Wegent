"""Jupyter kernel context management."""

import logging
import uuid
from typing import Dict, Optional

import httpx

from .consts import JUPYTER_BASE_URL
from .messaging import ContextWebSocket

logger = logging.getLogger(__name__)


def normalize_language(language: Optional[str]) -> str:
    """Normalize language name to standard form."""
    if not language:
        return "python"

    language = language.lower().strip()

    if language == "js":
        return "javascript"

    if language == "ts":
        return "typescript"

    return language


def get_kernel_for_language(language: str) -> str:
    """Get the Jupyter kernel name for a language."""
    if language == "typescript":
        return "javascript"

    return language


async def create_context(
    client: httpx.AsyncClient,
    websockets: Dict[str, ContextWebSocket],
    language: str,
    cwd: str,
) -> dict:
    """Create a new Jupyter kernel context.

    Args:
        client: HTTP client for making requests
        websockets: Dictionary to store WebSocket connections
        language: Programming language for the kernel
        cwd: Current working directory for the context

    Returns:
        Dictionary with context information (id, language, cwd)
    """
    data = {
        "path": str(uuid.uuid4()),
        "kernel": {"name": get_kernel_for_language(language)},
        "type": "notebook",
        "name": str(uuid.uuid4()),
    }
    logger.debug(f"Creating new {language} context")

    response = await client.post(f"{JUPYTER_BASE_URL}/api/sessions", json=data)

    if not response.is_success:
        raise Exception(f"Failed to create context: {response.text}")

    session_data = response.json()
    session_id = session_data["id"]
    context_id = session_data["kernel"]["id"]

    logger.debug(f"Created context {context_id}")

    ws = ContextWebSocket(context_id, session_id, language, cwd)
    await ws.connect()
    websockets[context_id] = ws

    # Set working directory
    logger.info(f"Setting working directory to {cwd}")
    try:
        await ws.change_current_directory(cwd, language)
    except Exception as e:
        logger.error(f"Failed to set working directory: {e}")
        raise Exception("Failed to set working directory")

    return {"id": context_id, "language": language, "cwd": cwd}
