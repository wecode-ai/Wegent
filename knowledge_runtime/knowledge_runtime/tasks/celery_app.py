# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Celery application for knowledge_runtime stat tasks."""

from celery import Celery
from knowledge_runtime.config import get_settings

settings = get_settings()

# Use configured broker/backend or fallback to Redis URL
broker_url = settings.celery_broker_url or "redis://localhost:6379/0"
result_backend = settings.celery_result_backend or broker_url

celery_app = Celery(
    "knowledge_runtime",
    broker=broker_url,
    backend=result_backend,
    include=["knowledge_runtime.tasks.stat_tasks"],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    worker_prefetch_multiplier=1,
    task_acks_late=True,
    task_default_queue="kb_stat",
    task_routes={"kb_stat.*": {"queue": "kb_stat"}},
)
