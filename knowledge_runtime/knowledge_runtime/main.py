# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""FastAPI application entry point for knowledge_runtime service."""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from knowledge_runtime.api.router import router
from knowledge_runtime.config import get_settings
from knowledge_runtime.core.logging import setup_logging
from knowledge_runtime.middleware.auth import require_internal_service_token_configured

from shared.db.stat_session import StatDbNotConfiguredError
from shared.models import RemoteRagError

logger = logging.getLogger(__name__)


# Cap restart storms: at most this many worker respawns per hour. A healthy
# worker runs indefinitely; hitting the cap means something is fundamentally
# broken and we stop banging on it.
_WORKER_MAX_RESTARTS_PER_HOUR = 3


def _build_worker_command() -> list[str]:
    return [
        sys.executable,
        "-m",
        "celery",
        "-A",
        "knowledge_runtime.tasks.celery_app",
        "worker",
        "-Q",
        "kb_stat",
        "-c",
        "1",
        # Unique nodename: the default "celery@<hostname>" collides with the
        # knowledge_doc_converter worker on the same host (same Redis broker),
        # which trips DuplicateNodenameWarning during mingle and muddies
        # control-plane replies. "%h" keeps the hostname for multi-box clarity.
        "-n",
        "kb-stat@%h",
        "--loglevel=info",
    ]


class WorkerSupervisor:
    """Owns the Celery kb_stat worker subprocess for the FastAPI process.

    Responsibilities:
    - open the worker log file once and ALWAYS close it on shutdown (the old
      code leaked the fd because it only terminated the process);
    - supervise the worker in a background thread and restart it on crash,
      capped at ``_WORKER_MAX_RESTARTS_PER_HOUR`` to avoid restart storms;
    - stop cleanly on shutdown: signal the supervisor thread, terminate the
      worker, then close the log fd.
    """

    def __init__(self, log_path: str) -> None:
        self._log_path = log_path
        # Keep the fd on the instance so shutdown can close it deterministically.
        self._log_file = open(log_path, "a")  # noqa: SIM115 - closed in stop()
        self._cmd = _build_worker_command()
        self._process: subprocess.Popen | None = None
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._restart_times: list[float] = []

    def start(self) -> None:
        self._process = self._spawn()
        self._thread = threading.Thread(
            target=self._supervise, name="kb-stat-worker-supervisor", daemon=True
        )
        self._thread.start()
        logger.info(
            "KB stat worker started (pid=%s), log: %s",
            self._process.pid if self._process else "?",
            self._log_path,
        )

    def _spawn(self) -> subprocess.Popen:
        return subprocess.Popen(
            self._cmd,
            stdout=self._log_file,
            stderr=self._log_file,
            env=os.environ.copy(),
        )

    def _supervise(self) -> None:
        """Restart the worker if it exits unexpectedly (storm-limited)."""
        while not self._stop_event.is_set():
            proc = self._process
            if proc is None:
                return
            # Poll periodically so we notice crashes while honoring stop.
            while not self._stop_event.is_set():
                rc = proc.poll()
                if rc is not None:
                    break
                if self._stop_event.wait(timeout=5):
                    return
            if self._stop_event.is_set():
                return
            # Worker died unexpectedly.
            logger.warning("KB stat worker exited (rc=%s), evaluating restart", rc)
            if not self._allow_restart():
                logger.error(
                    "KB stat worker restart cap reached (%s/hour); giving up",
                    _WORKER_MAX_RESTARTS_PER_HOUR,
                )
                return
            try:
                self._process = self._spawn()
                logger.info("KB stat worker restarted (pid=%s)", self._process.pid)
            except Exception:
                logger.exception("KB stat worker restart failed; giving up")
                return

    def _allow_restart(self) -> bool:
        now = time.monotonic()
        # Drop timestamps older than 1 hour.
        self._restart_times = [t for t in self._restart_times if now - t < 3600]
        if len(self._restart_times) >= _WORKER_MAX_RESTARTS_PER_HOUR:
            return False
        self._restart_times.append(now)
        return True

    def stop(self) -> None:
        self._stop_event.set()
        proc = self._process
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=10)
                logger.info("KB stat worker terminated")
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        if self._thread is not None:
            self._thread.join(timeout=5)
        # Always close the log fd — this is the leak the old code had.
        try:
            self._log_file.close()
        except Exception:
            pass


def _mask_url(url: str) -> str:
    """Mask password in database URL for safe logging."""
    import re

    return re.sub(r"://([^:]+):([^@]+)@", r"://\1:****@", url)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler for startup and shutdown events."""
    settings = get_settings()

    # Initialize logging configuration
    setup_logging(
        log_file_enabled=settings.log_file_enabled,
        log_dir=settings.log_dir,
        log_level=settings.log_level,
    )
    require_internal_service_token_configured()

    # Initialize business database for config resolution
    if settings.database_url:
        from shared.db.sync_session import init_db

        init_db(settings.database_url)
        logger.info("Database initialized for config resolution")
    else:
        logger.warning("DATABASE_URL not configured - config resolution will not work")

    # Initialize stat database (lazy - only if URL is available)
    stat_url = settings.knowledge_stat_database_url or settings.database_url
    if stat_url:
        try:
            from shared.db.stat_session import init_stat_db

            init_stat_db(stat_url)
            logger.info(f"Stat database initialized (url: {_mask_url(stat_url)})")
        except Exception as e:
            logger.warning(f"Stat database initialization skipped: {e}")
    else:
        logger.warning("Stat database URL not configured")

    # Initialize readonly database (lazy)
    readonly_url = settings.database_readonly_url or settings.database_url
    if readonly_url:
        try:
            from shared.db.readonly_session import init_readonly_db

            init_readonly_db(readonly_url)
            src = (
                "read-only replica"
                if settings.database_readonly_url
                else "primary (fallback)"
            )
            logger.info(f"Readonly database initialized ({src})")
        except Exception as e:
            logger.warning(f"Readonly database initialization skipped: {e}")

    # KB stat worker info
    worker_enabled = settings.kb_stat_worker_enabled
    logger.info(
        f"KB stat worker: {'ENABLED' if worker_enabled else 'DISABLED'} "
        f"(KB_STAT_WORKER_ENABLED={worker_enabled})"
    )

    worker_supervisor: WorkerSupervisor | None = None

    if worker_enabled:
        # Start stat worker as a supervised subprocess: it auto-restarts on
        # crash (storm-limited) and its log fd is always closed on shutdown.
        try:
            log_dir = os.path.abspath(settings.log_dir)
            os.makedirs(log_dir, exist_ok=True)
            worker_supervisor = WorkerSupervisor(
                os.path.join(log_dir, "kb_stat_worker.log")
            )
            worker_supervisor.start()
        except Exception as e:
            logger.warning(f"KB stat worker failed to start: {e}")
            # Make sure we never leave a half-initialized supervisor around.
            if worker_supervisor is not None:
                worker_supervisor.stop()
                worker_supervisor = None
    else:
        logger.info("KB stat worker is disabled, skipping worker process")

    logger.info(
        f"knowledge_runtime starting on {settings.host}:{settings.port}",
    )
    yield
    # Shutdown: stop the supervisor (terminates worker + closes log fd).
    if worker_supervisor is not None:
        worker_supervisor.stop()
    logger.info("knowledge_runtime shutting down")


app = FastAPI(
    title="Wegent Knowledge Runtime",
    description="HTTP service for RAG operations and KB statistics, called by Backend",
    version="1.0.0",
    lifespan=lifespan,
)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Global exception handler that returns RemoteRagError format."""
    logger.exception(f"Unhandled exception for {request.url}: {exc}")

    retryable = getattr(exc, "retryable", None)
    if retryable is None:
        retryable = isinstance(exc, (ConnectionError, TimeoutError))

    error_response = RemoteRagError(
        code="internal_error",
        message="internal server error",
        retryable=retryable,
        details={"exception_type": type(exc).__name__},
    )

    return JSONResponse(
        status_code=500,
        content=error_response.model_dump(mode="json"),
    )


@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError) -> JSONResponse:
    """Handle ValueError as a bad request with RemoteRagError format."""
    logger.warning(f"ValueError for {request.url}: {exc}")

    error_response = RemoteRagError(
        code="invalid_request",
        message=str(exc),
        retryable=False,
    )

    return JSONResponse(
        status_code=400,
        content=error_response.model_dump(mode="json"),
    )


@app.exception_handler(StatDbNotConfiguredError)
async def stat_db_not_configured_handler(
    request: Request, exc: StatDbNotConfiguredError
) -> JSONResponse:
    """Return 503 when the stat database is not configured."""
    logger.warning(f"Stat DB not configured for {request.url}: {exc}")
    error_response = RemoteRagError(
        code="stat_db_unavailable",
        message="statistics database is not configured",
        retryable=False,
    )
    return JSONResponse(
        status_code=503,
        content=error_response.model_dump(mode="json"),
    )


app.include_router(router)


def run() -> None:
    """Run the FastAPI application using uvicorn."""
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "knowledge_runtime.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )


if __name__ == "__main__":
    run()
