# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Attachment handling module for Claude Code agent.

Handles downloading and processing attachments from the Backend API.
This module provides attachment lifecycle management for Claude Code agents.
"""

import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Union

from executor.agents.claude_code.multimodal_prompt import is_vision_prompt
from shared.logger import setup_logger
from shared.models.execution import ExecutionRequest
from shared.utils import git_util

logger = setup_logger("claude_code_attachment_handler")


@dataclass
class AttachmentProcessResult:
    """Result of attachment processing operation."""

    prompt: Union[str, list]  # Modified prompt with attachment references
    image_content_blocks: List[Dict[str, Any]]  # Image content blocks for vision
    success_count: int  # Number of successfully downloaded attachments
    failed_count: int  # Number of failed attachments


def download_attachments(
    task_data: ExecutionRequest,
    task_id: int,
    subtask_id: int,
    prompt: Union[str, list],
) -> AttachmentProcessResult:
    """Download attachments from Backend API to workspace.

    Downloads all attachments associated with the current subtask
    to a local directory, and updates the prompt to reference the local paths.

    Args:
        task_data: Task data object containing attachments and auth_token
        task_id: Task ID
        subtask_id: Subtask ID
        prompt: Original prompt to modify

    Returns:
        AttachmentProcessResult with modified prompt and image content blocks
    """
    attachments = task_data.attachments
    if not attachments:
        logger.debug("No attachments to download for this task")
        return AttachmentProcessResult(
            prompt=prompt,
            image_content_blocks=[],
            success_count=0,
            failed_count=0,
        )

    logger.info(f"Found {len(attachments)} attachments to download")

    # Get auth token for API calls
    auth_token = task_data.auth_token
    if not auth_token:
        logger.warning("No auth token available, cannot download attachments")
        return AttachmentProcessResult(
            prompt=prompt,
            image_content_blocks=[],
            success_count=0,
            failed_count=len(attachments),
        )

    try:
        from executor.services.attachment_downloader import AttachmentDownloader
        from executor.services.attachment_prompt_processor import (
            AttachmentPromptProcessor,
        )

        workspace, project_layout = _resolve_attachment_workspace(
            task_data,
            task_id,
        )
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
        image_content_blocks: List[Dict[str, Any]] = []
        prompt_has_inline_images = is_vision_prompt(prompt)

        # Process prompt to replace attachment references and add context
        if result.success or result.failed:
            # Rewrite backend attachment paths and replace [attachment:id] placeholders.
            modified_prompt = AttachmentPromptProcessor.process_prompt(
                prompt,
                result.success,
                result.failed,
                task_id=task_id,
                subtask_id=attachment_subtask_id,
            )

            # String prompts may still rely on explicit attachment context. For
            # content-block prompts, backend has already injected attachment
            # metadata and content, so path rewriting is sufficient.
            if isinstance(modified_prompt, str):
                attachment_context = AttachmentPromptProcessor.build_attachment_context(
                    result.success,
                )
                if attachment_context:
                    modified_prompt += attachment_context

            logger.info(f"Processed prompt with {len(result.success)} attachments")

            # Vision prompts already contain inline image data from backend.
            if not prompt_has_inline_images:
                image_content_blocks = (
                    AttachmentPromptProcessor.build_image_content_blocks(result.success)
                )
                if image_content_blocks:
                    logger.info(
                        f"Built {len(image_content_blocks)} image content blocks"
                    )

        if result.failed:
            logger.warning(
                f"Failed to download {len(result.failed)} attachments: "
                f"{[a.get('original_filename') for a in result.failed]}"
            )

        return AttachmentProcessResult(
            prompt=modified_prompt,
            image_content_blocks=image_content_blocks,
            success_count=len(result.success),
            failed_count=len(result.failed),
        )

    except Exception as e:
        logger.error(f"Error downloading attachments: {e}")
        # Don't raise - attachment download failure shouldn't block task execution
        return AttachmentProcessResult(
            prompt=prompt,
            image_content_blocks=[],
            success_count=0,
            failed_count=len(attachments),
        )


def _resolve_attachment_workspace(
    task_data: ExecutionRequest,
    task_id: int,
) -> tuple[str, bool]:
    """Resolve attachment root and layout for Claude Code downloads."""

    from executor.config import config

    project_workspace = getattr(task_data, "project_workspace_path", None)
    if not project_workspace and task_data.project_id and task_data.git_url:
        repo_name = git_util.get_repo_name_from_url(task_data.git_url)
        safe_repo_name = repo_name.replace("/", "_").replace("\\", "_")
        project_workspace = os.path.join(
            "projects", str(task_data.project_id), safe_repo_name
        )

    if project_workspace:
        project_workspace = os.path.expanduser(str(project_workspace))
        if not os.path.isabs(project_workspace):
            project_workspace = os.path.join(
                config.get_workspace_root(), project_workspace
            )
        return os.path.join(project_workspace, ".wegent", "attachments"), True

    return os.path.join(config.get_workspace_root(), str(task_id)), False


def _resolve_attachment_subtask_id(
    attachments: list[dict[str, Any]],
    fallback: int,
) -> int:
    """Prefer the source user-message subtask id embedded in attachment metadata."""

    for attachment in attachments:
        subtask_id = attachment.get("subtask_id")
        if subtask_id is not None:
            return int(subtask_id)
    return int(fallback)


def get_attachment_thinking_step_details(
    result: AttachmentProcessResult,
) -> Optional[Dict[str, Any]]:
    """Get thinking step details for attachment download result.

    Args:
        result: Attachment processing result

    Returns:
        Details dict for thinking step, or None if no successful downloads
    """
    if result.success_count > 0:
        return {"count": result.success_count}
    return None
