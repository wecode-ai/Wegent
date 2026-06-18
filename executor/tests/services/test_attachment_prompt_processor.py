# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import base64
import binascii
import struct
import zlib

from executor.services.attachment_prompt_processor import AttachmentPromptProcessor
from executor.services.image_preprocessor import MAX_MODEL_IMAGE_LONG_EDGE


def _make_png(width: int, height: int) -> bytes:
    raw_rows = b"".join(b"\x00" + (b"\x00\x7f\xff" * width) for _ in range(height))

    def chunk(name: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + name
            + data
            + struct.pack(">I", binascii.crc32(name + data) & 0xFFFFFFFF)
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw_rows))
        + chunk(b"IEND", b"")
    )


def _png_size(data: bytes) -> tuple[int, int]:
    assert data.startswith(b"\x89PNG\r\n\x1a\n")
    return struct.unpack(">II", data[16:24])


class TestAttachmentPromptProcessor:
    def test_rewrites_source_subtask_sandbox_path_to_local_execution_path(self):
        """Source-subtask placeholders should rewrite to the downloaded execution path."""
        prompt = [
            {
                "type": "input_text",
                "text": (
                    "[Attachment: xxx.html | ID: 301 | File Path(already in sandbox): "
                    "/home/user/1251:executor:attachments/1676/xxx.html]"
                ),
            },
            {"type": "input_text", "text": "upload this file"},
        ]

        processed = AttachmentPromptProcessor.process_prompt(
            prompt=prompt,
            success_attachments=[
                {
                    "id": 301,
                    "original_filename": "xxx.html",
                    "subtask_id": 1676,
                    "local_path": "/Users/test/.wecode/wegent-executor/workspace/1251/1251:executor:attachments/1677/xxx.html",
                }
            ],
            failed_attachments=[],
            task_id=1251,
            subtask_id=1677,
        )

        assert (
            "Local File Path: "
            "/Users/test/.wecode/wegent-executor/workspace/1251/1251:executor:attachments/1677/xxx.html"
            in processed[0]["text"]
        )
        assert (
            "/home/user/1251:executor:attachments/1676/xxx.html"
            not in processed[0]["text"]
        )

    def test_rewrites_backend_sandbox_path_to_local_path_in_text_blocks(self):
        """Backend-injected sandbox paths should be rewritten for local executor."""
        prompt = [
            {
                "type": "input_text",
                "text": (
                    "[Attachment: xxx.md | ID: 274 | File Path(already in sandbox): "
                    "/home/user/1233:executor:attachments/1642/xxx.md]"
                ),
            },
            {"type": "input_text", "text": "upload this file"},
        ]

        processed = AttachmentPromptProcessor.process_prompt(
            prompt=prompt,
            success_attachments=[
                {
                    "id": 274,
                    "original_filename": "xxx.md",
                    "local_path": "/Users/test/.wegent-executor/workspace/1233/1233:executor:attachments/1642/xxx.md",
                }
            ],
            failed_attachments=[],
            task_id=1233,
            subtask_id=1642,
        )

        assert (
            "Local File Path: "
            "/Users/test/.wegent-executor/workspace/1233/1233:executor:attachments/1642/xxx.md"
            in processed[0]["text"]
        )
        assert (
            "/home/user/1233:executor:attachments/1642/xxx.md"
            not in processed[0]["text"]
        )

    def test_build_attachment_context_lists_available_attachments_without_layout_guidance(
        self,
    ):
        """Attachment context should list files without extra directory guidance."""
        context = AttachmentPromptProcessor.build_attachment_context(
            success_attachments=[
                {
                    "id": 274,
                    "original_filename": "xxx.md",
                    "local_path": "/Users/test/.wegent-executor/workspace/1233/1233:executor:attachments/1642/xxx.md",
                    "file_size": 4096,
                    "mime_type": "text/markdown",
                }
            ]
        )

        assert "xxx.md" in context
        assert (
            "Do not assume a workspace/<task_id>/attachments/ directory." not in context
        )

    def test_build_image_content_blocks_downscales_large_images(self, tmp_path):
        """Large image attachments should be resized before model submission."""
        image_path = tmp_path / "large.png"
        image_path.write_bytes(_make_png(width=3000, height=1500))

        blocks = AttachmentPromptProcessor.build_image_content_blocks(
            success_attachments=[
                {
                    "id": 1,
                    "original_filename": "large.png",
                    "local_path": str(image_path),
                    "mime_type": "image/png",
                }
            ],
        )

        image_data = base64.b64decode(blocks[0]["source"]["data"])
        width, height = _png_size(image_data)
        assert blocks[0]["source"]["media_type"] == "image/png"
        assert width == MAX_MODEL_IMAGE_LONG_EDGE
        assert height == MAX_MODEL_IMAGE_LONG_EDGE // 2
