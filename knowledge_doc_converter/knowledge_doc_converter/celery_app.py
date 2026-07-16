"""Celery application configuration for the converter service.

Configures the Celery app, sets up logging via Celery signals, and
applies request_id-aware log formatting with optional file output.
"""

import logging

from celery import Celery
from celery.signals import after_setup_logger, after_setup_task_logger, worker_init

from knowledge_doc_converter.config import settings
from knowledge_doc_converter.core.logging import apply_celery_format, setup_logging

# Initialize logging before creating the Celery app so that
# any logging during app creation uses the correct format.
setup_logging(
    log_file_enabled=settings.LOG_FILE_ENABLED,
    log_dir=settings.LOG_DIR,
    log_level=settings.LOG_LEVEL,
)


def _include_tasks() -> list[str]:
    """Build the task module include list.

    The MinerU conversion task is always included. The multimodal analysis task
    is included only when ``MULTIMODAL_ENABLED`` is set, so a worker that does
    not opt in to multimodal analysis never imports the Gemini SDK dependency
    (and never registers the multimodal queue consumer).
    """
    tasks = ["knowledge_doc_converter.tasks.conversion_task"]
    if settings.MULTIMODAL_ENABLED:
        tasks.append("knowledge_doc_converter.tasks.multimodal_task")
    return tasks


celery_app = Celery(
    "knowledge_doc_converter",
    broker=settings.CELERY_BROKER_URL,
    backend=settings.CELERY_RESULT_BACKEND,
    include=_include_tasks(),
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    worker_prefetch_multiplier=1,
    task_acks_late=True,
    task_reject_on_worker_lost=True,
)


@after_setup_logger.connect
def _setup_celery_logger(logger, *args, **kwargs):
    """Configure Celery root logger to use converter's log format + file handlers."""
    apply_celery_format(
        logger,
        log_file_enabled=settings.LOG_FILE_ENABLED,
        log_dir=settings.LOG_DIR,
    )


@after_setup_task_logger.connect
def _setup_celery_task_logger(logger, *args, **kwargs):
    """Configure Celery task logger to use converter's log format + file handlers."""
    apply_celery_format(
        logger,
        log_file_enabled=settings.LOG_FILE_ENABLED,
        log_dir=settings.LOG_DIR,
    )


@worker_init.connect
def _start_metrics_server(**kwargs):
    """Start Prometheus metrics server when the worker initializes."""
    if settings.PROMETHEUS_ENABLED:
        from knowledge_doc_converter.core.metrics import start_metrics_server

        start_metrics_server(settings.PROMETHEUS_PORT, settings.PROMETHEUS_PATH)
