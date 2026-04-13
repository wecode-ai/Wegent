# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

from executor.agents.claude_code.attachment_handler import download_attachments
from shared.models.execution import ExecutionRequest


class TestDownloadAttachments:
    def test_non_vision_list_prompt_still_downloads_attachments(self):
        """Text-only content block prompts should still trigger attachment download."""
        task_data = ExecutionRequest(
            auth_token="test-token",  # noqa: S106
            attachments=[{"id": 274, "original_filename": "xxx.md"}],
        )
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

        download_result = MagicMock()
        download_result.success = [
            {
                "id": 274,
                "original_filename": "xxx.md",
                "local_path": "/tmp/workspace/1233:executor:attachments/1642/xxx.md",
                "mime_type": "text/markdown",
                "file_size": 57036,
            }
        ]
        download_result.failed = []

        with patch("executor.config.config.get_workspace_root", return_value="/tmp"):
            with patch(
                "executor.services.attachment_downloader.AttachmentDownloader.download_all",
                return_value=download_result,
            ) as mock_download_all:
                result = download_attachments(
                    task_data=task_data,
                    task_id=1233,
                    subtask_id=1642,
                    prompt=prompt,
                )

        mock_download_all.assert_called_once()
        assert result.success_count == 1
        assert (
            "/tmp/workspace/1233:executor:attachments/1642/xxx.md"
            in result.prompt[0]["text"]
        )

    def test_string_prompt_does_not_inject_layout_guidance_in_local_mode(self):
        """Local mode should rely on rewritten file paths instead of extra layout guidance."""
        task_data = ExecutionRequest(
            auth_token="test-token",  # noqa: S106
            attachments=[{"id": 274, "original_filename": "xxx.md"}],
        )
        prompt = "summarize this attachment"

        download_result = MagicMock()
        download_result.success = [
            {
                "id": 274,
                "original_filename": "xxx.md",
                "local_path": "/workspace/1233/1233:executor:attachments/1642/xxx.md",
                "mime_type": "text/markdown",
                "file_size": 57036,
            }
        ]
        download_result.failed = []

        with (
            patch("executor.config.config.EXECUTOR_MODE", "local"),
            patch(
                "executor.config.config.get_workspace_root",
                return_value="/Users/test/.wegent-executor/workspace",
            ),
            patch(
                "executor.services.attachment_downloader.AttachmentDownloader.download_all",
                return_value=download_result,
            ),
        ):
            result = download_attachments(
                task_data=task_data,
                task_id=1233,
                subtask_id=1642,
                prompt=prompt,
            )

        assert (
            "Do not assume a workspace/<task_id>/attachments/ directory."
            not in result.prompt
        )
