# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Host the embedded Chat Shell service protocol for the Rust dispatcher."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI

from app.core.config import settings
from app.services.auth.internal_service_token import verify_internal_service_token

PACKAGE_RUNTIME_PATH = "/_runtime/chat-shell"


def mount_package_runtime(app: FastAPI) -> None:
    """Reuse the engine's existing routes without another Backend API handler."""
    if settings.CHAT_SHELL_MODE != "package":
        return

    from chat_shell.api.v1.response import router

    runtime = FastAPI(
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        dependencies=[Depends(verify_internal_service_token)],
    )
    runtime.include_router(router)
    app.mount(PACKAGE_RUNTIME_PATH, runtime)


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
