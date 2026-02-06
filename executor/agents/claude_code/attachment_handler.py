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
from typing import Any, Dict, List, Optional

from shared.logger import setup_logger

logger = setup_logger("claude_code_attachment_handler")


@dataclass
class AttachmentProcessResult:
    """Result of attachment processing operation."""

    prompt: str  # Modified prompt with attachment references
    image_content_blocks: List[Dict[str, Any]]  # Image content blocks for vision
    success_count: int  # Number of successfully downloaded attachments
    failed_count: int  # Number of failed attachments


def download_attachments(
    task_data: Dict[str, Any],
    task_id: int,
    subtask_id: int,
    prompt: str,
) -> AttachmentProcessResult:
    """Download attachments from Backend API to workspace.

    Downloads all attachments associated with the current subtask
    to a local directory, and updates the prompt to reference the local paths.

    Args:
        task_data: Task data dictionary containing attachments and auth_token
        task_id: Task ID
        subtask_id: Subtask ID
        prompt: Original prompt to modify

    Returns:
        AttachmentProcessResult with modified prompt and image content blocks
    """
    attachments = task_data.get("attachments", [])
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
    auth_token = task_data.get("auth_token")
    if not auth_token:
        logger.warning("No auth token available, cannot download attachments")
        return AttachmentProcessResult(
            prompt=prompt,
            image_content_blocks=[],
            success_count=0,
            failed_count=len(attachments),
        )

    try:
        from executor.config import config
        from executor.services.attachment_downloader import AttachmentDownloader
        from executor.services.attachment_prompt_processor import (
            AttachmentPromptProcessor,
        )

        # Determine workspace path for attachments
        workspace = os.path.join(config.get_workspace_root(), str(task_id))

        downloader = AttachmentDownloader(
            workspace=workspace,
            task_id=str(task_id),
            subtask_id=str(subtask_id),
            auth_token=auth_token,
        )

        result = downloader.download_all(attachments)

        modified_prompt = prompt
        image_content_blocks: List[Dict[str, Any]] = []

        # Process prompt to replace attachment references and add context
        if result.success or result.failed:
            # Replace [attachment:id] references with local paths
            modified_prompt = AttachmentPromptProcessor.process_prompt(
                prompt, result.success, result.failed
            )

            # Add context about available attachments
            attachment_context = AttachmentPromptProcessor.build_attachment_context(
                result.success
            )
            if attachment_context:
                modified_prompt += attachment_context

            logger.info(f"Processed prompt with {len(result.success)} attachments")

            # Build image content blocks for potential vision support
            image_content_blocks = AttachmentPromptProcessor.build_image_content_blocks(
                result.success
            )
            if image_content_blocks:
                logger.info(f"Built {len(image_content_blocks)} image content blocks")

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
