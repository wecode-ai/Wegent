# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from sqlalchemy.orm import Session

from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.services.chat.preprocessing.contexts import (
    _validate_attachment_ownership,
    link_contexts_to_subtask,
    prepare_contexts_for_chat,
)


def _create_ready_attachment(
    db: Session,
    *,
    user_id: int,
    source: str | None = None,
    extracted_text: str = "",
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
        extracted_text=extracted_text,
        text_length=len(extracted_text),
        type_data=type_data,
    )
    db.add(context)
    db.flush()
    return context


def _create_ready_image_attachment(
    db: Session,
    *,
    user_id: int,
    source: str | None = None,
) -> SubtaskContext:
    type_data = {
        "original_filename": "reference.png",
        "file_extension": ".png",
        "file_size": 128,
        "mime_type": "image/png",
    }
    if source:
        type_data["source"] = source

    context = SubtaskContext(
        subtask_id=0,
        user_id=user_id,
        context_type=ContextType.ATTACHMENT.value,
        name="reference.png",
        status=ContextStatus.READY.value,
        image_base64="aW1hZ2U=",
        type_data=type_data,
    )
    db.add(context)
    db.flush()
    return context


def test_validate_attachment_ownership_keeps_user_and_preset_attachments(
    test_db: Session,
) -> None:
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

    assert valid_ids == [user_attachment.id, preset_attachment.id]


def test_validate_attachment_ownership_deduplicates_repeated_ids(
    test_db: Session,
) -> None:
    attachment = _create_ready_attachment(test_db, user_id=7)

    valid_ids = _validate_attachment_ownership(
        db=test_db,
        attachment_ids=[attachment.id, attachment.id],
        user_id=7,
    )

    assert valid_ids == [attachment.id]


def test_link_contexts_to_subtask_keeps_user_and_preset_attachments(
    test_db: Session,
) -> None:
    user_attachment = _create_ready_attachment(test_db, user_id=7)
    preset_attachment = _create_ready_attachment(
        test_db,
        user_id=7,
        source="quick_launch_preset",
    )

    linked_ids = link_contexts_to_subtask(
        db=test_db,
        subtask_id=42,
        user_id=7,
        attachment_ids=[user_attachment.id, preset_attachment.id],
        contexts=None,
    )

    test_db.refresh(user_attachment)
    test_db.refresh(preset_attachment)

    assert linked_ids == [user_attachment.id, preset_attachment.id]
    assert user_attachment.subtask_id == 42
    assert preset_attachment.subtask_id == 42


@pytest.mark.asyncio
async def test_user_and_preset_attachments_reach_model_context(
    test_db: Session,
) -> None:
    user_attachment = _create_ready_attachment(
        test_db,
        user_id=7,
        extracted_text="User attachment content",
    )
    preset_attachment = _create_ready_attachment(
        test_db,
        user_id=7,
        source="quick_launch_preset",
        extracted_text="Preset attachment content",
    )
    link_contexts_to_subtask(
        db=test_db,
        subtask_id=42,
        user_id=7,
        attachment_ids=[user_attachment.id, preset_attachment.id],
        contexts=None,
    )

    result = await prepare_contexts_for_chat(
        db=test_db,
        user_subtask_id=42,
        user_id=7,
        message="Summarize the attachments",
        base_system_prompt="",
        model_config={},
    )

    assert isinstance(result.final_message, list)
    model_text = "\n".join(
        block["text"]
        for block in result.final_message
        if block.get("type") == "input_text"
    )
    assert "User attachment content" in model_text
    assert "Preset attachment content" in model_text


@pytest.mark.asyncio
async def test_preset_image_reaches_image_generation_context(
    test_db: Session,
) -> None:
    preset_attachment = _create_ready_image_attachment(
        test_db,
        user_id=7,
        source="quick_launch_preset",
    )
    link_contexts_to_subtask(
        db=test_db,
        subtask_id=42,
        user_id=7,
        attachment_ids=[preset_attachment.id],
        contexts=None,
    )

    result = await prepare_contexts_for_chat(
        db=test_db,
        user_subtask_id=42,
        user_id=7,
        message="Place it on Mars",
        base_system_prompt="",
        model_config={
            "modelType": "image",
            "imageConfig": {
                "capabilities": {"supports_image_input": True},
            },
        },
    )

    assert isinstance(result.final_message, list)
    assert {
        "type": "input_image",
        "image_url": "data:image/png;base64,aW1hZ2U=",
    } in result.final_message
    assert result.final_message[-1] == {
        "type": "input_text",
        "text": "Place it on Mars",
    }
