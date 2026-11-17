# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Host Python execution runtimes for the Rust dispatcher."""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import anyio
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import StreamingResponse

from app.core.config import settings
from app.services.auth.internal_service_token import verify_internal_service_token
from app.services.execution.emitters.sse import SSEResultEmitter
from shared.models import ExecutionRequest

PACKAGE_RUNTIME_PATH = "/_runtime/chat-shell"
IMAGE_EXECUTION_ROUTE = "/v1/image-execution"
IMAGE_EXECUTION_PATH = f"{PACKAGE_RUNTIME_PATH}{IMAGE_EXECUTION_ROUTE}"


def mount_package_runtime(app: FastAPI) -> None:
    """Mount the private runtimes with the internal service credential."""
    runtime = FastAPI(
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        dependencies=[Depends(verify_internal_service_token)],
    )
    runtime.add_api_route(IMAGE_EXECUTION_ROUTE, execute_image, methods=["POST"])
    if settings.CHAT_SHELL_MODE == "package":
        from chat_shell.api.v1.response import router

        runtime.include_router(router)
    app.mount(PACKAGE_RUNTIME_PATH, runtime)


async def execute_image(request: ExecutionRequest) -> StreamingResponse:
    """Stream the existing image agent's execution events to the dispatcher."""
    if request.model_config.get("modelType") != "image":
        raise HTTPException(status_code=422, detail="Expected an image model")
    if request.task_id <= 0 or request.subtask_id <= 0:
        raise HTTPException(status_code=422, detail="Expected a persisted task turn")
    return StreamingResponse(_image_events(request), media_type="text/event-stream")


async def _image_events(request: ExecutionRequest) -> AsyncIterator[str]:
    from app.services.execution.agents.image.image_agent import ImageAgent

    emitter = SSEResultEmitter(request.task_id, request.subtask_id)

    async def generate() -> None:
        try:
            await ImageAgent().execute(request, emitter, owns_cancel_flag=False)
        finally:
            await emitter.close()

    worker = asyncio.create_task(generate())
    try:
        async for frame in emitter.stream_sse():
            yield frame
        await worker
    finally:
        if not worker.done():
            worker.cancel()
        with anyio.CancelScope(shield=True):
            await asyncio.gather(worker, return_exceptions=True)


@asynccontextmanager
async def package_runtime_lifespan() -> AsyncIterator[None]:
    """Drain embedded engine streams before Backend resources are closed."""
    if settings.CHAT_SHELL_MODE != "package":
        yield
        return

    from chat_shell.core.shutdown import shutdown_manager

    try:
        yield
    finally:
        await shutdown_manager.initiate_shutdown()
        completed = await shutdown_manager.wait_for_streams(
            timeout=settings.GRACEFUL_SHUTDOWN_TIMEOUT
        )
        if not completed:
            await shutdown_manager.cancel_all_streams()
