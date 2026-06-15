# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

from executor.agents.claude_code.attachment_handler import download_attachments
from executor.services.attachment_downloader import AttachmentDownloadResult
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

    def test_project_zero_workspace_downloads_to_project_attachment_layout(
        self, tmp_path
    ):
        """Wework standalone chats should keep attachments under the chat workspace."""
        project_workspace = tmp_path / "chats" / "2026-06-12" / "hello"
        local_image = (
            project_workspace / ".wegent" / "attachments" / "31" / "45" / "image.png"
        )
        local_image.parent.mkdir(parents=True)
        local_image.write_bytes(b"png")
        sandbox_path = "/home/user/31:executor:attachments/45/image.png"
        task_data = ExecutionRequest(
            task_id=31,
            subtask_id=46,
            auth_token="test-token",  # noqa: S106
            project_id=0,
            standalone_chat_workspace=True,
            workspace_source="local_path",
            project_workspace_path=str(project_workspace),
            user_subtask_id=45,
            attachments=[
                {
                    "id": 16,
                    "original_filename": "image.png",
                    "mime_type": "image/png",
                    "file_size": 3,
                    "subtask_id": 45,
                }
            ],
        )
        prompt = [
            {
                "type": "input_text",
                "text": (
                    "<attachment>[Image Attachment: image.png | ID: 16 | "
                    "File Path(already in sandbox): "
                    f"{sandbox_path}]</attachment>"
                ),
            }
        ]

        download_calls = []

        def fake_download_all(self, attachments):
            download_calls.append(attachments)
            assert self.workspace == str(project_workspace / ".wegent" / "attachments")
            assert self.project_layout is True
            assert self.subtask_id == "45"
            assert self.get_attachment_path("image.png") == str(local_image)
            return AttachmentDownloadResult(
                success=[{**attachments[0], "local_path": str(local_image)}],
                failed=[],
            )

        with patch(
            "executor.services.attachment_downloader.AttachmentDownloader.download_all",
            fake_download_all,
        ):
            result = download_attachments(
                task_data=task_data,
                task_id=31,
                subtask_id=46,
                prompt=prompt,
            )

        assert len(download_calls) == 1
        assert result.success_count == 1
        assert sandbox_path not in result.prompt[0]["text"]
        assert f"Local File Path: {local_image}" in result.prompt[0]["text"]
