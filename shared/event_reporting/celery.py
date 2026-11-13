"""Attempt facts for two named tasks, using Celery's actual execution outcome."""

from __future__ import annotations

from typing import Any

from .catalogs.knowledge import error_code_for, loaded_scalar, observe

_TASKS = {
    "app.tasks.knowledge_tasks.index_document": "knowledge.index.attempt",
    "knowledge_doc_converter.convert_multimodal": "knowledge.conversion.attempt",
}
_installed = False


def _fields(task, task_id, args, kwargs, state, retval) -> dict[str, Any]:
    def argument(name, position=None):
        if name in kwargs:
            return kwargs[name]
        return args[position] if position is not None and len(args) > position else None

    is_index = task.name == "app.tasks.knowledge_tasks.index_document"
    return {
        "kb_id": argument("knowledge_base_id", 0 if is_index else None),
        "document_id": argument("document_id", 8 if is_index else None),
        "status": "started" if state is None else "completed",
        "fact_key_parts": (task_id, task.request.retries),
        "error_code": error_code_for(retval) if isinstance(retval, Exception) else None,
        "data": {
            "task_id": task_id,
            "attempt": task.request.retries,
            "generation": argument("index_generation", 9 if is_index else None),
            "trigger": argument("trigger", 13 if is_index else None),
            "media_type": argument("media_type"),
            "file_extension": argument("file_extension"),
            "task_state": state,
            "result_status": loaded_scalar(retval, "status"),
            "reason": loaded_scalar(retval, "reason"),
        },
    }


def task_started(
    sender=None, task=None, task_id=None, args=None, kwargs=None, **unused
):
    task = task or sender
    name = _TASKS.get(getattr(task, "name", None))
    if name:
        observe(
            f"{name}.started",
            lambda: _fields(task, task_id, args or (), kwargs or {}, None, None),
        )


def task_finished(
    sender=None,
    task=None,
    task_id=None,
    args=None,
    kwargs=None,
    state=None,
    retval=None,
    **unused,
):
    task = task or sender
    name = _TASKS.get(getattr(task, "name", None))
    if name:
        observe(
            f"{name}.finished",
            lambda: _fields(task, task_id, args or (), kwargs or {}, state, retval),
        )


def install_task_logging() -> None:
    """Only callers that already depend on Celery import its signals."""
    global _installed
    if _installed:
        return
    from celery.signals import task_postrun, task_prerun

    task_prerun.connect(task_started, weak=False)
    task_postrun.connect(task_finished, weak=False)
    _installed = True
