# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Attachment prompt processor for executor.

Processes prompts to replace attachment references with local paths
and builds image content blocks for vision support.
"""

import base64
import logging
import re
from typing import Any, Dict, List, Union

logger = logging.getLogger(__name__)

# Image MIME types that support vision
IMAGE_MIME_TYPES = {
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/webp",
    "image/bmp",
}


class AttachmentPromptProcessor:
    """Process prompt to replace attachment references and add warnings"""

    # Pattern to match [attachment:123] format references
    ATTACHMENT_REF_PATTERN = re.compile(r"\[attachment:(\d+)\]")

    @classmethod
    def process_prompt(
        cls,
        prompt: Union[str, list[dict[str, Any]]],
        success_attachments: List[Dict[str, Any]],
        failed_attachments: List[Dict[str, Any]],
        task_id: int | None = None,
        subtask_id: int | None = None,
    ) -> Union[str, list[dict[str, Any]]]:
        """
        Process prompt to replace attachment references with local paths
        and add warnings for failed downloads.

        Args:
            prompt: Original prompt text
            success_attachments: Successfully downloaded attachments with local_path
            failed_attachments: Failed attachments with error info

        Returns:
            Processed prompt with replacements and warnings
        """
        # Build id -> attachment mapping for successful downloads
        id_to_attachment = {att["id"]: att for att in success_attachments}

        # Build set of failed attachment IDs
        failed_ids = {att["id"] for att in failed_attachments}

        def replace_ref(match: re.Match) -> str:
            """Replace attachment reference with local path or unavailable message"""
            att_id = int(match.group(1))
            if att_id in id_to_attachment:
                att = id_to_attachment[att_id]
                local_path = att.get("local_path", "")
                return f"[Attachment downloaded to: {local_path}]"
            elif att_id in failed_ids:
                return f"[Attachment {att_id} unavailable - download failed]"
            else:
                return f"[Attachment {att_id} unavailable]"

        def rewrite_text(text: str) -> str:
            processed_text = cls.ATTACHMENT_REF_PATTERN.sub(replace_ref, text)

            for att in success_attachments:
                local_path = att.get("local_path", "")
                if not local_path:
                    continue

                sandbox_path = cls._build_sandbox_path(
                    task_id=task_id,
                    subtask_id=att.get("subtask_id", subtask_id),
                    filename=att.get("original_filename", ""),
                )
                if sandbox_path:
                    processed_text = processed_text.replace(
                        f"File Path(already in sandbox): {sandbox_path}",
                        f"Local File Path: {local_path}",
                    )
                    processed_text = processed_text.replace(sandbox_path, local_path)

            if failed_attachments:
                warning_lines = [
                    "\n\n⚠️ The following attachments failed to download and are unavailable:"
                ]
                for att in failed_attachments:
                    filename = att.get("original_filename", "unknown")
                    error = att.get("error", "Unknown error")
                    warning_lines.append(f"- {filename} (Error: {error})")
                processed_text += "\n".join(warning_lines)

            return processed_text

        if isinstance(prompt, list):
            processed_blocks: list[dict[str, Any]] = []
            for block in prompt:
                updated_block = block.copy()
                if updated_block.get("type") in ("input_text", "text") and isinstance(
                    updated_block.get("text"), str
                ):
                    updated_block["text"] = rewrite_text(updated_block["text"])
                processed_blocks.append(updated_block)
            return processed_blocks

        return rewrite_text(prompt)

    @staticmethod
    def _build_sandbox_path(
        task_id: int | None,
        subtask_id: int | None,
        filename: str,
    ) -> str | None:
        """Build the backend-injected sandbox path for attachment text blocks."""
        if task_id is None or subtask_id is None:
            return None

        safe_name = filename.replace("\n", "").replace("\r", "")
        return f"/home/user/{task_id}:executor:attachments/{subtask_id}/{safe_name}"

    @classmethod
    def build_attachment_context(
        cls,
        success_attachments: List[Dict[str, Any]],
    ) -> str:
        """
        Build context information about available attachments.

        Args:
            success_attachments: Successfully downloaded attachments
        Returns:
            Context string describing available attachments and their paths,
            wrapped in <attachment> tags
        """
        if not success_attachments:
            return ""

        context_lines = ["📎 Available attachments:"]
        for att in success_attachments:
            filename = att.get("original_filename", "unknown")
            local_path = att.get("local_path", "")
            file_size = att.get("file_size", 0)
            mime_type = att.get("mime_type", "unknown")

            # Format file size for display
            if file_size >= 1024 * 1024:
                size_str = f"{file_size / (1024 * 1024):.1f} MB"
            elif file_size >= 1024:
                size_str = f"{file_size / 1024:.1f} KB"
            else:
                size_str = f"{file_size} bytes"

            context_lines.append(
                f"- {filename} ({mime_type}, {size_str}): {local_path}"
            )

        return "\n\n<attachment>\n" + "\n".join(context_lines) + "\n</attachment>"

    @classmethod
    def build_image_content_blocks(
        cls,
        success_attachments: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """
        Build vision content blocks for image attachments.

        Reads image files from local_path and converts them to base64.
        This allows the executor to handle images without receiving
        base64 data in the task payload.

        Args:
            success_attachments: Successfully downloaded attachments with local_path

        Returns:
            List of content blocks for Claude vision API
        """
        content_blocks = []

        for att in success_attachments:
            mime_type = att.get("mime_type", "")
            local_path = att.get("local_path", "")

            # Skip non-image attachments
            if mime_type not in IMAGE_MIME_TYPES:
                continue

            # Skip if no local path (download failed)
            if not local_path:
                logger.warning(
                    f"Image attachment {att.get('id')} has no local_path, skipping"
                )
                continue

            # Read image file and convert to base64
            try:
                with open(local_path, "rb") as f:
                    image_data = f.read()
                image_base64 = base64.b64encode(image_data).decode("utf-8")

                # Build vision content block
                content_blocks.append(
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": mime_type,
                            "data": image_base64,
                        },
                    }
                )
                logger.debug(
                    f"Built image content block for {att.get('original_filename')}"
                )
            except FileNotFoundError:
                logger.error(f"Image file not found: {local_path}")
            except IOError as e:
                logger.error(f"Error reading image file {local_path}: {e}")
            except Exception as e:
                logger.error(f"Unexpected error processing image {local_path}: {e}")

        return content_blocks
