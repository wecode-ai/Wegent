"""
Scheduler Backend Abstraction Layer.

This module provides a pluggable scheduler backend system that supports
multiple scheduling engines:

- **Celery Beat** (default): Distributed task queue with Redis broker
- **APScheduler**: Lightweight, no external dependencies
- **XXL-JOB**: Enterprise-grade distributed scheduling

Usage:
    # Get the configured scheduler backend
    from app.core.scheduler import get_scheduler_backend

    scheduler = get_scheduler_backend()
    scheduler.start()

    # Or use the factory directly
    from app.core.scheduler import get_scheduler_backend
    scheduler = get_scheduler_backend("apscheduler")

Configuration:
    # In .env or settings
    SCHEDULER_BACKEND=celery      # default
    SCHEDULER_BACKEND=apscheduler # lightweight
    SCHEDULER_BACKEND=xxljob      # enterprise

    # APScheduler options
    APSCHEDULER_JOB_STORE=memory  # or sqlite

    # XXL-JOB options
    XXLJOB_ADMIN_ADDRESSES=http://admin1:8080,http://admin2:8080
    XXLJOB_APP_NAME=wegent-executor
    XXLJOB_ACCESS_TOKEN=your_token

Registering Custom Backends:
    from app.core.scheduler import register_scheduler_backend

    def create_custom_backend():
        return MyCustomBackend()

    register_scheduler_backend("custom", create_custom_backend)
"""

import logging
from typing import List, Optional

from app.core.scheduler.base import (
    JobExecutionResult,
    ScheduledJob,
    SchedulerBackend,
    SchedulerState,
)
from app.core.scheduler.factory import (
    SchedulerBackendRegistry,
    clear_active_scheduler,
    get_active_scheduler,
    get_scheduler_backend,
    is_scheduler_backend_registered,
    list_scheduler_backends,
    register_scheduler_backend,
    set_active_scheduler,
    unregister_scheduler_backend,
)

logger = logging.getLogger(__name__)

__all__ = [
    # Base classes
    "SchedulerBackend",
    "SchedulerState",
    "ScheduledJob",
    "JobExecutionResult",
    # Registry and factory
    "SchedulerBackendRegistry",
    "register_scheduler_backend",
    "unregister_scheduler_backend",
    "get_scheduler_backend",
    "get_active_scheduler",
    "set_active_scheduler",
    "clear_active_scheduler",
    "list_scheduler_backends",
    "is_scheduler_backend_registered",
    # Initialization
    "init_scheduler_backends",
]


def init_scheduler_backends() -> List[str]:
    """
    Initialize and register all scheduler backends.

    This function registers the default backends and any configured
    optional backends. It should be called during application startup.

    Returns:
        List of registered backend type names
    """
    from app.core.scheduler.factory import _registry

    registered = []

    # Always register Celery backend (default)
    try:
        from app.core.scheduler.celery_backend import CeleryBeatBackend

        _registry.register("celery", lambda: CeleryBeatBackend(), override=True)
        registered.append("celery")
        logger.debug("[Scheduler] Registered Celery Beat backend")
    except Exception as e:
        logger.error(f"[Scheduler] Failed to register Celery backend: {e}")

    # Register APScheduler backend if available
    try:
        from app.core.config import settings
        from app.core.scheduler.apscheduler_backend import APSchedulerBackend

        job_store = getattr(settings, "APSCHEDULER_JOB_STORE", "memory")
        _registry.register(
            "apscheduler",
            lambda: APSchedulerBackend(job_store=job_store),
            override=True,
        )
        registered.append("apscheduler")
        logger.debug("[Scheduler] Registered APScheduler backend")
    except ImportError:
        logger.debug(
            "[Scheduler] APScheduler not available (apscheduler package not installed)"
        )
    except Exception as e:
        logger.warning(f"[Scheduler] Failed to register APScheduler backend: {e}")

    # Register XXL-JOB backend if configured
    try:
        from app.core.config import settings

        xxl_job_addresses = getattr(settings, "XXLJOB_ADMIN_ADDRESSES", "")
        if xxl_job_addresses:
            from app.core.scheduler.xxljob_backend import XXLJobBackend

            admin_addresses = [
                addr.strip() for addr in xxl_job_addresses.split(",") if addr.strip()
            ]

            _registry.register(
                "xxljob",
                lambda: XXLJobBackend(
                    admin_addresses=admin_addresses,
                    app_name=getattr(settings, "XXLJOB_APP_NAME", "wegent-executor"),
                    access_token=getattr(settings, "XXLJOB_ACCESS_TOKEN", None) or None,
                    executor_port=getattr(settings, "XXLJOB_EXECUTOR_PORT", 9999),
                ),
                override=True,
            )
            registered.append("xxljob")
            logger.debug("[Scheduler] Registered XXL-JOB backend")
    except ImportError:
        logger.debug("[Scheduler] XXL-JOB backend requirements not available")
    except Exception as e:
        logger.warning(f"[Scheduler] Failed to register XXL-JOB backend: {e}")

    logger.info(f"[Scheduler] Initialized backends: {registered}")
    return registered


def start_scheduler() -> Optional[SchedulerBackend]:
    """
    Start the configured scheduler backend.

    This is a convenience function that:
    1. Initializes all backends
    2. Gets the configured backend
    3. Starts it
    4. Sets it as active

    Returns:
        The started SchedulerBackend instance, or None on failure
    """
    from app.core.config import settings

    # Initialize backends
    init_scheduler_backends()

    # Get configured backend
    backend_type = getattr(settings, "SCHEDULER_BACKEND", "celery")
    logger.info(f"[Scheduler] Starting scheduler backend: {backend_type}")

    try:
        scheduler = get_scheduler_backend(backend_type)
        scheduler.start()
        set_active_scheduler(scheduler)
        logger.info(
            f"[Scheduler] Backend '{scheduler.backend_type}' started successfully"
        )
        return scheduler
    except Exception as e:
        logger.error(f"[Scheduler] Failed to start backend '{backend_type}': {e}")
        return None


def stop_scheduler() -> None:
    """
    Stop the active scheduler backend.

    This is a convenience function that stops and clears the active scheduler.
    """
    scheduler = get_active_scheduler()
    if scheduler:
        try:
            scheduler.stop()
            logger.info(f"[Scheduler] Backend '{scheduler.backend_type}' stopped")
        except Exception as e:
            logger.error(f"[Scheduler] Error stopping backend: {e}")
        finally:
            clear_active_scheduler()
    else:
        logger.debug("[Scheduler] No active scheduler to stop")
