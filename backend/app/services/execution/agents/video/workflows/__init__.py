# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Workflow-managed video integrations."""

from collections.abc import Callable

from .base import VideoWorkflowClient

_workflow_client_factories: dict[str, Callable[[], VideoWorkflowClient]] = {}


def register_video_workflow_client(
    workflow_type: str,
    factory: Callable[[], VideoWorkflowClient],
) -> None:
    """Register an external video workflow client factory."""
    normalized_type = workflow_type.strip()
    if not normalized_type:
        raise ValueError("workflow_type is required")
    existing = _workflow_client_factories.get(normalized_type)
    if existing is not None and existing is not factory:
        raise ValueError(f"Video workflow already registered: {normalized_type}")
    _workflow_client_factories[normalized_type] = factory


def get_video_workflow_client(workflow_type: str) -> VideoWorkflowClient:
    """Resolve a configured external video workflow client."""
    factory = _workflow_client_factories.get(workflow_type)
    if factory is None:
        raise ValueError(f"Unknown video workflow: {workflow_type}")
    return factory()


__all__ = [
    "VideoWorkflowClient",
    "get_video_workflow_client",
    "register_video_workflow_client",
]
