# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Attachment prompt processor for executor.

Processes prompts to replace attachment references with local paths
and builds image content blocks for vision support.
"""

import re
from typing import Any, Dict, List


class AttachmentPromptProcessor:
    """Process prompt to replace attachment references and add warnings"""

    # Pattern to match [attachment:123] format references
    ATTACHMENT_REF_PATTERN = re.compile(r"\[attachment:(\d+)\]")

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

        Args:
            success_attachments: Successfully downloaded attachments

        Returns:
            Context string describing available attachments and their paths
        """
        if not success_attachments:
            return ""

        context_lines = ["\n\n📎 Available attachments:"]
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

        return "\n".join(context_lines)

    @classmethod
    def build_image_content_blocks(
        cls,
        success_attachments: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """
        Build vision content blocks for image attachments.

        Args:
            success_attachments: Successfully downloaded attachments

        Returns:
            List of content blocks for Claude vision API
        """
        content_blocks = []

        for att in success_attachments:
            image_base64 = att.get("image_base64")
            if not image_base64:
                continue

            mime_type = att.get("mime_type", "image/png")

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

        return content_blocks
