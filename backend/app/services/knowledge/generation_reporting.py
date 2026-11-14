"""Copy task outcomes; never treat a background task as a provider RPC."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from shared.event_reporting.catalogs.knowledge import loaded_scalar, observe

if TYPE_CHECKING:
    from app.services.background_chat_executor import (
        BackgroundTaskConfig,
        BackgroundTaskResult,
    )


def report_generation(
    result: BackgroundTaskResult,
    *,
    config: BackgroundTaskConfig,
    model_config: dict[str, Any] | None,
    duration_ms: int | None = None,
) -> BackgroundTaskResult:
    observe(
        "knowledge.generation.task.finished",
        lambda: {
            "kb_id": loaded_scalar(config, "knowledge_base_id"),
            "document_id": loaded_scalar(config, "document_id"),
            "status": "success" if result.success else "failed",
            # Monotonic elapsed measured by the executor; absent on callers
            # without a start reference.
            "duration_ms": duration_ms,
            "data": {
                "stage": "background_task",
                "generation_type": loaded_scalar(config, "task_type"),
                "model_role": "generation",
                "model_name": loaded_scalar(model_config, "model_name"),
                "model_namespace": loaded_scalar(model_config, "model_namespace"),
                "model_id": loaded_scalar(model_config, "model_id"),
                "task_id": result.task_id,
                "subtask_id": result.subtask_id,
                "result_status": result.success,
            },
        },
    )
    return result
