"""Code Interpreter Server - FastAPI server for executing code in Jupyter kernels."""

import json
import logging
import sys
from contextlib import asynccontextmanager
from typing import AsyncIterable, Dict, List, Mapping, Optional, Union

import httpx
from fastapi import FastAPI
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field

from .consts import JUPYTER_BASE_URL
from .contexts import create_context, normalize_language
from .messaging import ContextWebSocket

# Configure logging
logging.basicConfig(level=logging.DEBUG, stream=sys.stdout)
logger = logging.getLogger(__name__)

# Reduce HTTP client logging noise
http_logger = logging.getLogger("httpcore.http11")
http_logger.setLevel(logging.WARNING)


# Pydantic models for API
class ExecutionRequest(BaseModel):
    """Request model for code execution."""

    code: str = Field(description="Code to be executed")
    context_id: Optional[str] = Field(default=None, description="Context ID")
    language: Optional[str] = Field(default=None, description="Language of the code")


class CreateContextRequest(BaseModel):
    """Request model for creating a context."""

    cwd: Optional[str] = Field(
        default="/home/user", description="Current working directory"
    )
    language: Optional[str] = Field(
        default="python", description="Language of the context"
    )


class Context(BaseModel):
    """Context information."""

    id: str = Field(description="Context ID")
    language: str = Field(description="Language of the context")
    cwd: str = Field(description="Current working directory of the context")


# Global state
websockets: Dict[str, ContextWebSocket] = {}
default_context_ids: Dict[str, str] = {}  # language -> context_id
client: Optional[httpx.AsyncClient] = None


class StreamingJsonLinesResponse(StreamingResponse):
    """Streaming response that outputs JSON lines (one JSON object per line)."""

    def __init__(
        self,
        content_generator: AsyncIterable,
        status_code: int = 200,
        headers: Optional[Mapping[str, str]] = None,
        media_type: str = "application/x-ndjson",
    ) -> None:
        body_iterator = self._encoded_async_generator(content_generator)
        super().__init__(
            content=body_iterator,
            status_code=status_code,
            headers=headers,
            media_type=media_type,
        )

    async def _encoded_async_generator(self, async_generator: AsyncIterable):
        """Convert async generator items to JSON lines."""
        async for item in async_generator:
            yield f"{json.dumps(item)}\n"
        yield '{"type": "end_of_execution"}\n'


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager - initializes default contexts."""
    global client

    client = httpx.AsyncClient()

    try:
        # Create default Python context
        python_context = await create_context(
            client, websockets, "python", "/home/user"
        )
        default_context_ids["python"] = python_context["id"]
        default_context_ids["default"] = python_context["id"]

        logger.info("Connected to default Python runtime")
        yield

        # Cleanup on shutdown
        for ws in websockets.values():
            await ws.close()

        await client.aclose()
    except Exception as e:
        logger.error(f"Failed to initialize default context: {e}")
        raise


app = FastAPI(lifespan=lifespan)

logger.info("Starting Code Interpreter server")


@app.get("/health")
async def get_health():
    """Health check endpoint."""
    return "OK"


@app.post("/execute")
async def post_execute(exec_request: ExecutionRequest):
    """Execute code in a Jupyter kernel.

    Returns a streaming response with JSON lines containing:
    - stdout: {"type": "stdout", "text": "..."}
    - stderr: {"type": "stderr", "text": "..."}
    - result: {"type": "result", "text": "...", "is_main_result": true/false, ...}
    - error: {"type": "error", "name": "...", "value": "...", "traceback": "..."}
    - number_of_executions: {"type": "number_of_executions", "execution_count": N}
    - end_of_execution: {"type": "end_of_execution"}
    """
    logger.info(f"Executing code: {exec_request.code[:100]}...")

    # Validate request - only one of context_id or language can be provided
    if exec_request.context_id and exec_request.language:
        return PlainTextResponse(
            "Only one of context_id or language can be provided",
            status_code=400,
        )

    context_id = None

    if exec_request.language:
        language = normalize_language(exec_request.language)
        context_id = default_context_ids.get(language)

        if not context_id:
            # Create a new default context for this language
            try:
                context = await create_context(
                    client, websockets, language, "/home/user"
                )
                context_id = context["id"]
                default_context_ids[language] = context_id
            except Exception as e:
                return PlainTextResponse(str(e), status_code=500)

    elif exec_request.context_id:
        context_id = exec_request.context_id

    # Get the WebSocket connection
    if context_id:
        ws = websockets.get(context_id)
    else:
        default_id = default_context_ids.get("default")
        ws = websockets.get(default_id) if default_id else None

    if not ws:
        return PlainTextResponse(
            f"Context {exec_request.context_id} not found",
            status_code=404,
        )

    return StreamingJsonLinesResponse(ws.execute(exec_request.code))


@app.post("/contexts")
async def post_contexts(request: CreateContextRequest) -> Context:
    """Create a new execution context."""
    logger.info("Creating a new context")

    language = normalize_language(request.language)
    cwd = request.cwd or "/home/user"

    try:
        context = await create_context(client, websockets, language, cwd)
        return Context(**context)
    except Exception as e:
        return PlainTextResponse(str(e), status_code=500)


@app.get("/contexts")
async def get_contexts() -> List[Context]:
    """List all active contexts."""
    logger.info("Listing contexts")

    return [
        Context(
            id=ws.context_id,
            language=ws.language,
            cwd=ws.cwd,
        )
        for ws in websockets.values()
    ]


@app.post("/contexts/{context_id}/restart")
async def restart_context(context_id: str):
    """Restart a context's kernel."""
    logger.info(f"Restarting context {context_id}")

    ws = websockets.get(context_id)
    if not ws:
        return PlainTextResponse(
            f"Context {context_id} not found",
            status_code=404,
        )

    session_id = ws.session_id

    await ws.close()

    response = await client.post(f"{JUPYTER_BASE_URL}/api/kernels/{context_id}/restart")
    if not response.is_success:
        return PlainTextResponse(
            f"Failed to restart context {context_id}",
            status_code=500,
        )

    # Reconnect with new WebSocket
    new_ws = ContextWebSocket(
        context_id,
        session_id,
        ws.language,
        ws.cwd,
    )
    await new_ws.connect()
    websockets[context_id] = new_ws

    return {"status": "restarted"}


@app.delete("/contexts/{context_id}")
async def remove_context(context_id: str):
    """Remove a context and its kernel."""
    logger.info(f"Removing context {context_id}")

    ws = websockets.get(context_id)
    if not ws:
        return PlainTextResponse(
            f"Context {context_id} not found",
            status_code=404,
        )

    try:
        await ws.close()
    except Exception:
        pass

    response = await client.delete(f"{JUPYTER_BASE_URL}/api/kernels/{context_id}")
    if not response.is_success:
        return PlainTextResponse(
            f"Failed to remove context {context_id}",
            status_code=500,
        )

    del websockets[context_id]

    # Clean up from default contexts if present
    for lang, cid in list(default_context_ids.items()):
        if cid == context_id:
            del default_context_ids[lang]

    return {"status": "removed"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=49999)
