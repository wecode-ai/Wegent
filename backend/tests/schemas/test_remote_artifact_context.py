# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timezone

from app.models.subtask_context import ContextType, SubtaskContext
from app.schemas.subtask_context import SubtaskContextBrief, SubtaskContextResponse


def test_metadata_only_artifact_is_exposed_as_a_persisted_downloadable_context():
    context = SubtaskContext(
        id=17,
        user_id=3,
        subtask_id=7,
        context_type=ContextType.REMOTE_WORKSPACE_ARTIFACT.value,
        name="report.md",
        status="ready",
        binary_data=b"",
        extracted_text="",
        text_length=0,
        created_at=datetime.now(timezone.utc),
        type_data={
            "task_id": 42,
            "relative_path": "outputs/report.md",
            "file_size": 17,
            "mime_type": "text/plain",
            "source": {
                "executor_name": "device-original",
                "workspace_root": "/private/original",
            },
        },
    )
    brief = SubtaskContextBrief.from_model(context)
    assert brief.remote_task_id == 42
    assert brief.remote_path == "outputs/report.md"
    assert brief.context_type == ContextType.REMOTE_WORKSPACE_ARTIFACT
    assert "source" not in brief.model_dump()
    assert "/private/original" not in brief.model_dump_json()
    assert SubtaskContextResponse.model_validate(context).context_type == (
        ContextType.REMOTE_WORKSPACE_ARTIFACT
    )
