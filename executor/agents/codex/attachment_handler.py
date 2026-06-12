# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Attachment handling for the Codex agent."""

import os
from dataclasses import dataclass
from typing import Any, Union

from executor.config import config
from executor.services.attachment_downloader import AttachmentDownloader
from executor.services.attachment_prompt_processor import (
    IMAGE_MIME_TYPES,
    AttachmentPromptProcessor,
)
from shared.logger import setup_logger
from shared.models.execution import ExecutionRequest

logger = setup_logger("codex_attachment_handler")


@dataclass
class CodexAttachmentProcessResult:
    """Result of preparing attachments for a Codex turn."""

    prompt: Union[str, list[dict[str, Any]]]
    local_image_paths: list[str | None]
    success_count: int
    failed_count: int


def process_codex_attachments(
    task_data: ExecutionRequest,
    task_id: int,
    subtask_id: int,
    prompt: Union[str, list[dict[str, Any]]],
) -> CodexAttachmentProcessResult:
    """Download attachments and rewrite backend sandbox paths for Codex."""

    attachments = task_data.attachments
    if not attachments:
        return CodexAttachmentProcessResult(
            prompt=prompt,
            local_image_paths=[],
            success_count=0,
            failed_count=0,
        )

    auth_token = task_data.auth_token
    if not auth_token:
        logger.warning("No auth token available, cannot download Codex attachments")
        return CodexAttachmentProcessResult(
            prompt=prompt,
            local_image_paths=[],
            success_count=0,
            failed_count=len(attachments),
        )

    try:
        workspace, project_layout = _resolve_attachment_workspace()
        attachment_subtask_id = _resolve_attachment_subtask_id(
            attachments,
            fallback=getattr(task_data, "user_subtask_id", None) or subtask_id,
        )
        downloader = AttachmentDownloader(
            workspace=workspace,
            task_id=str(task_id),
            subtask_id=str(attachment_subtask_id),
            auth_token=auth_token,
            project_layout=project_layout,
        )
        result = downloader.download_all(attachments)

        modified_prompt = prompt
        if result.success or result.failed:
            modified_prompt = AttachmentPromptProcessor.process_prompt(
                prompt,
                result.success,
                result.failed,
                task_id=task_id,
                subtask_id=attachment_subtask_id,
            )
            if isinstance(modified_prompt, str):
                attachment_context = AttachmentPromptProcessor.build_attachment_context(
                    result.success,
                )
                if attachment_context:
                    modified_prompt += attachment_context

        success_by_id = {att.get("id"): att for att in result.success}
        local_image_paths = []
        for attachment in attachments:
            if attachment.get("mime_type") not in IMAGE_MIME_TYPES:
                continue
            success_attachment = success_by_id.get(attachment.get("id"))
            local_path = (
                str(success_attachment["local_path"])
                if success_attachment and success_attachment.get("local_path")
                else None
            )
            local_image_paths.append(local_path)
        logger.info(
            "Prepared Codex attachments: %s success, %s failed, %s local images",
            len(result.success),
            len(result.failed),
            len([path for path in local_image_paths if path]),
        )
        return CodexAttachmentProcessResult(
            prompt=modified_prompt,
            local_image_paths=local_image_paths,
            success_count=len(result.success),
            failed_count=len(result.failed),
        )
    except Exception as exc:
        logger.error("Error preparing Codex attachments: %s", exc)
        return CodexAttachmentProcessResult(
            prompt=prompt,
            local_image_paths=[],
            success_count=0,
            failed_count=len(attachments),
        )


def _resolve_attachment_workspace() -> tuple[str, bool]:
    return os.path.join(config.get_workspace_root(), "attachments"), True


def _resolve_attachment_subtask_id(
    attachments: list[dict[str, Any]],
    fallback: int,
) -> int:
    for attachment in attachments:
        subtask_id = attachment.get("subtask_id")
        if subtask_id is not None:
            return int(subtask_id)
    return int(fallback)
