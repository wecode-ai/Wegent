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
from typing import Any, Dict, List

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

    @staticmethod
    def format_file_size(size_bytes: int) -> str:
        """
        Format file size in bytes to human-readable format.

        Args:
            size_bytes: File size in bytes

        Returns:
            Formatted string like "2.5 MB", "156.3 KB", or "512 bytes"
        """
        if size_bytes >= 1024 * 1024:
            return f"{size_bytes / (1024 * 1024):.1f} MB"
        elif size_bytes >= 1024:
            return f"{size_bytes / 1024:.1f} KB"
        else:
            return f"{size_bytes} bytes"

    @staticmethod
    def build_attachment_url(attachment_id: int) -> str:
        """
        Build the download URL for an attachment.

        Args:
            attachment_id: Attachment ID

        Returns:
            Relative URL path for downloading the attachment
        """
        return f"/api/attachments/{attachment_id}/download"

    @classmethod
    def process_prompt(
        cls,
        prompt: str,
        success_attachments: List[Dict[str, Any]],
        failed_attachments: List[Dict[str, Any]],
    ) -> str:
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
        processed_prompt = prompt

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

        processed_prompt = cls.ATTACHMENT_REF_PATTERN.sub(replace_ref, processed_prompt)

        # Add warning for failed attachments at the end of prompt
        if failed_attachments:
            warning_lines = [
                "\n\n⚠️ The following attachments failed to download and are unavailable:"
            ]
            for att in failed_attachments:
                filename = att.get("original_filename", "unknown")
                error = att.get("error", "Unknown error")
                warning_lines.append(f"- {filename} (Error: {error})")
            processed_prompt += "\n".join(warning_lines)

        return processed_prompt

    @classmethod
    def build_attachment_context(
        cls,
        success_attachments: List[Dict[str, Any]],
    ) -> str:
        """
        Build context information about available attachments.

        Includes attachment metadata (id, filename, mime_type, file_size, url).

        Args:
            success_attachments: Successfully downloaded attachments

        Returns:
            Context string describing available attachments and their paths
        """
        if not success_attachments:
            return ""

        context_lines = ["\n\n📎 Available attachments:"]
        for att in success_attachments:
            att_id = att.get("id", 0)
            filename = att.get("original_filename", "unknown")
            local_path = att.get("local_path", "")
            file_size = att.get("file_size", 0)
            mime_type = att.get("mime_type", "unknown")

            # Format file size for display
            formatted_size = cls.format_file_size(file_size)
            url = cls.build_attachment_url(att_id)

            context_lines.append(
                f"[Attachment: {filename} | ID: {att_id} | "
                f"Type: {mime_type} | Size: {formatted_size} | URL: {url}]\n"
                f"  Local path: {local_path}"
            )

        return "\n".join(context_lines)

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
