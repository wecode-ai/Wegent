# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Replay public write responses without restoring state or past authority."""

from copy import deepcopy

from fastapi.encoders import jsonable_encoder

from app.models.cloud_project import CloudProject

PUBLIC_PROJECT_FIELDS = (
    "id",
    "public_id",
    "project_key",
    "name",
    "title",
    "description",
    "created_by_user_id",
    "status",
    "version",
    "created_at",
    "updated_at",
)
PUBLIC_METADATA_FIELDS = (
    "task_provider",
    "tags",
    "membership_mode",
    "default_issue_security",
    "card_display",
    "board_config",
    "board_views",
    "collaboration_policy",
    "ai_automation",
    "pull_request_automation",
    "workflow_automation_id",
)


def public_write_snapshot(project: CloudProject) -> dict:
    """Keep an allowlist; never journal credentials or executable configuration."""
    values = project_response_values(project)
    metadata = values["metadata_json"]
    return jsonable_encoder(
        {
            **{field: values[field] for field in PUBLIC_PROJECT_FIELDS},
            "metadata_json": {
                field: metadata[field]
                for field in PUBLIC_METADATA_FIELDS
                if field in metadata
            },
        }
    )


def project_response_values(project: CloudProject, *, write: bool = False) -> dict:
    """Load current values and optionally overlay public fields from the receipt."""
    values = {field: getattr(project, field) for field in PUBLIC_PROJECT_FIELDS}
    metadata = dict(project.metadata_json or {})
    values["metadata_json"] = metadata
    values["_project_admin_result"] = getattr(project, "_project_admin_result", None)
    snapshot = getattr(project, "_project_admin_response", None) if write else None
    if snapshot is None:
        return values
    for field in PUBLIC_METADATA_FIELDS:
        metadata.pop(field, None)
    metadata.update(deepcopy(snapshot["metadata_json"]))
    return {**values, **snapshot, "metadata_json": metadata}
