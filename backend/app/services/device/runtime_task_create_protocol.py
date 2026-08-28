# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Negotiate Runtime task-create wire payloads at the transport boundary."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RuntimeTaskCreateProtocolError(ValueError):
    """The connected Runtime cannot preserve requested create semantics."""

    features: tuple[str, ...]

    def __str__(self) -> str:
        return (
            "Connected Executor does not support runtime task-create features: "
            + ", ".join(self.features)
        )


FEATURE_FIELDS: dict[str, tuple[str, ...]] = {
    "attachments": ("attachments",),
    "goal": ("initialGoal",),
    "permissionMode": ("runtimePermissionMode",),
    "projectPlugins": ("projectPlugins",),
    "standaloneWorkspace": ("standaloneChatWorkspace",),
    "supervisor": ("initialSupervisor",),
    "workspaceInheritance": ("workspaceSourceTask",),
}


def negotiate_runtime_task_create_payload(
    payload: dict[str, Any],
    runtime_features: Any,
) -> dict[str, Any]:
    """Select V2 or a lossless V1 representation for one connected Runtime."""

    requested_version = _positive_int(payload.get("schemaVersion")) or 1
    if requested_version == 1:
        return _without_schema_version(payload)

    protocol = _runtime_task_create_features(runtime_features)
    supported_versions = _supported_versions(protocol)
    advertised_features = _advertised_features(protocol)
    required_features = _required_features(payload)

    if 2 in supported_versions:
        unsupported = tuple(
            feature
            for feature in required_features
            if advertised_features.get(feature) is False
        )
        if unsupported:
            raise RuntimeTaskCreateProtocolError(unsupported)
        return dict(payload)

    if required_features:
        raise RuntimeTaskCreateProtocolError(required_features)
    if supported_versions and 1 not in supported_versions:
        raise RuntimeTaskCreateProtocolError(("schemaVersion:2",))
    return _without_schema_version(payload)


def _runtime_task_create_features(runtime_features: Any) -> dict[str, Any]:
    if not isinstance(runtime_features, dict):
        return {}
    value = runtime_features.get("runtimeTaskCreate")
    return value if isinstance(value, dict) else {}


def _supported_versions(protocol: dict[str, Any]) -> frozenset[int]:
    versions = protocol.get("schemaVersions")
    if not isinstance(versions, list):
        return frozenset()
    return frozenset(
        value for item in versions if (value := _positive_int(item)) is not None
    )


def _advertised_features(protocol: dict[str, Any]) -> dict[str, bool]:
    features = protocol.get("features")
    if not isinstance(features, dict):
        return {}
    return {
        str(key): value for key, value in features.items() if isinstance(value, bool)
    }


def _required_features(payload: dict[str, Any]) -> tuple[str, ...]:
    required = [
        feature
        for feature, fields in FEATURE_FIELDS.items()
        if any(_field_is_used(payload, field) for field in fields)
    ]
    if _uses_skills(payload):
        required.append("skills")
    if _uses_worktree(payload):
        required.append("worktree")
    return tuple(required)


def _field_is_used(payload: dict[str, Any], field: str) -> bool:
    value = payload.get(field)
    return value is not None and value is not False and value != [] and value != {}


def _uses_skills(payload: dict[str, Any]) -> bool:
    execution_request = payload.get("executionRequest")
    if not isinstance(execution_request, dict):
        return False
    return _field_is_used(execution_request, "preload_skills")


def _uses_worktree(payload: dict[str, Any]) -> bool:
    execution = payload.get("execution")
    if not isinstance(execution, dict):
        return False
    workspace = execution.get("workspace")
    return isinstance(workspace, dict) and workspace.get("source") == "git_worktree"


def _without_schema_version(payload: dict[str, Any]) -> dict[str, Any]:
    downgraded = dict(payload)
    downgraded.pop("schemaVersion", None)
    downgraded.pop("schema_version", None)
    return downgraded


def _positive_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        return None
    return value
