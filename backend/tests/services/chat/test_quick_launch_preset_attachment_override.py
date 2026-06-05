# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.services.chat.preprocessing.contexts import _validate_attachment_ownership


def _create_ready_attachment(
    db,
    *,
    user_id: int,
    source: str | None = None,
) -> SubtaskContext:
    type_data = {
        "original_filename": "attachment.txt",
        "file_extension": ".txt",
        "file_size": 12,
        "mime_type": "text/plain",
    }
    if source:
        type_data["source"] = source

    context = SubtaskContext(
        subtask_id=0,
        user_id=user_id,
        context_type=ContextType.ATTACHMENT.value,
        name="attachment.txt",
        status=ContextStatus.READY.value,
        type_data=type_data,
    )
    db.add(context)
    db.flush()
    return context


def test_validate_attachment_ownership_drops_quick_launch_preset_when_user_attachment_exists(
    test_db,
):
    user_attachment = _create_ready_attachment(test_db, user_id=7)
    preset_attachment = _create_ready_attachment(
        test_db,
        user_id=7,
        source="quick_launch_preset",
    )

    valid_ids = _validate_attachment_ownership(
        db=test_db,
        attachment_ids=[user_attachment.id, preset_attachment.id],
        user_id=7,
    )

    assert valid_ids == [user_attachment.id]


def test_validate_attachment_ownership_keeps_quick_launch_preset_when_it_is_the_only_attachment(
    test_db,
):
    preset_attachment = _create_ready_attachment(
        test_db,
        user_id=7,
        source="quick_launch_preset",
    )

    valid_ids = _validate_attachment_ownership(
        db=test_db,
        attachment_ids=[preset_attachment.id],
        user_id=7,
    )

    assert valid_ids == [preset_attachment.id]
