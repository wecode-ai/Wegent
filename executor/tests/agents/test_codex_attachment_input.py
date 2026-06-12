# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock

from executor.agents.codex.codex_agent import CodeXAgent
from executor.services.attachment_downloader import AttachmentDownloadResult
from shared.models.execution import ExecutionRequest


def _codex_request(**overrides):
    data = {
        "task_id": 29,
        "subtask_id": 44,
        "model_config": {
            "model": "openai",
            "model_id": "gpt-5.5",
            "api_format": "responses",
        },
    }
    data.update(overrides)
    return ExecutionRequest(**data)


def test_codex_build_turn_input_preserves_inline_image_blocks():
    request = _codex_request(
        prompt=[
            {"type": "input_text", "text": "Analyze this image"},
            {"type": "input_image", "image_url": "data:image/png;base64,abc"},
        ],
    )
    agent = CodeXAgent(request, MagicMock())

    turn_input = agent._build_turn_input()

    assert [type(item).__name__ for item in turn_input] == ["TextInput", "ImageInput"]
    assert turn_input[0].text == "Analyze this image"
    assert turn_input[1].url == "data:image/png;base64,abc"


def test_codex_attachment_processing_rewrites_sandbox_path_to_local_image(
    tmp_path,
    monkeypatch,
):
    workspace_root = tmp_path / "workspace"
    local_image = workspace_root / "attachments" / "29" / "43" / "image.png"
    local_image.parent.mkdir(parents=True)
    local_image.write_bytes(b"png")
    sandbox_path = "/home/user/29:executor:attachments/43/image.png"
    request = _codex_request(
        auth_token="token",
        prompt=[
            {
                "type": "input_text",
                "text": (
                    "<attachment>[Image Attachment: image.png | ID: 15 | "
                    "File Path(already in sandbox): "
                    f"{sandbox_path}]</attachment>"
                ),
            },
            {"type": "input_image", "image_url": "data:image/png;base64,abc"},
            {"type": "input_text", "text": "分析一下这张图片"},
        ],
        attachments=[
            {
                "id": 15,
                "original_filename": "image.png",
                "mime_type": "image/png",
                "file_size": 3,
                "subtask_id": 43,
            }
        ],
    )
    agent = CodeXAgent(request, MagicMock())
    monkeypatch.setattr(
        "executor.agents.codex.attachment_handler.config.get_workspace_root",
        lambda: str(workspace_root),
    )

    def fake_download_all(self, attachments):
        assert self.workspace == str(workspace_root / "attachments")
        assert self.project_layout is True
        assert self.get_attachment_path("image.png") == str(local_image)
        return AttachmentDownloadResult(
            success=[{**attachments[0], "local_path": str(local_image)}],
            failed=[],
        )

    monkeypatch.setattr(
        "executor.services.attachment_downloader.AttachmentDownloader.download_all",
        fake_download_all,
    )

    agent._process_attachments_for_codex()
    turn_input = agent._build_turn_input()

    text = turn_input[0].text
    assert sandbox_path not in text
    assert text == (
        "\n# Files mentioned by the user:\n\n"
        f"## image.png: {local_image}\n\n"
        "## My request for Codex:\n"
        "分析一下这张图片\n"
    )
    assert [type(item).__name__ for item in turn_input] == [
        "TextInput",
        "LocalImageInput",
    ]
    assert turn_input[1].path == str(local_image)


def test_codex_attachment_only_empty_text_leaves_request_empty(tmp_path, monkeypatch):
    local_image = tmp_path / "image.png"
    local_image.write_bytes(b"png")
    request = _codex_request(
        auth_token="token",
        prompt=[
            {
                "type": "input_text",
                "text": "<attachment>[Image Attachment: image.png]</attachment>",
            },
            {"type": "input_image", "image_url": "data:image/png;base64,abc"},
            {"type": "input_text", "text": ""},
        ],
        attachments=[
            {
                "id": 15,
                "original_filename": "image.png",
                "mime_type": "image/png",
                "file_size": 3,
                "subtask_id": 43,
            }
        ],
    )
    agent = CodeXAgent(request, MagicMock())

    def fake_download_all(self, attachments):
        return AttachmentDownloadResult(
            success=[{**attachments[0], "local_path": str(local_image)}],
            failed=[],
        )

    monkeypatch.setattr(
        "executor.services.attachment_downloader.AttachmentDownloader.download_all",
        fake_download_all,
    )

    agent._process_attachments_for_codex()
    turn_input = agent._build_turn_input()

    assert turn_input[0].text == (
        "\n# Files mentioned by the user:\n\n"
        f"## image.png: {local_image}\n\n"
        "## My request for Codex:\n"
        "\n"
    )


def test_codex_preserves_literal_attachment_reference_request(tmp_path, monkeypatch):
    local_image = tmp_path / "image.png"
    local_image.write_bytes(b"png")
    request = _codex_request(
        auth_token="token",
        prompt=[
            {
                "type": "input_text",
                "text": "<attachment>[Image Attachment: image.png]</attachment>",
            },
            {"type": "input_image", "image_url": "data:image/png;base64,abc"},
            {"type": "input_text", "text": "请参考附件"},
        ],
        attachments=[
            {
                "id": 15,
                "original_filename": "image.png",
                "mime_type": "image/png",
                "file_size": 3,
                "subtask_id": 43,
            }
        ],
    )
    agent = CodeXAgent(request, MagicMock())

    def fake_download_all(self, attachments):
        return AttachmentDownloadResult(
            success=[{**attachments[0], "local_path": str(local_image)}],
            failed=[],
        )

    monkeypatch.setattr(
        "executor.services.attachment_downloader.AttachmentDownloader.download_all",
        fake_download_all,
    )

    agent._process_attachments_for_codex()
    turn_input = agent._build_turn_input()

    assert turn_input[0].text == (
        "\n# Files mentioned by the user:\n\n"
        f"## image.png: {local_image}\n\n"
        "## My request for Codex:\n"
        "请参考附件\n"
    )


def test_codex_attachment_processing_keeps_image_order_when_download_fails(
    tmp_path,
    monkeypatch,
):
    second_image = tmp_path / "second.png"
    second_image.write_bytes(b"png")
    request = _codex_request(
        auth_token="token",
        prompt=[
            {"type": "input_text", "text": "Compare these images"},
            {"type": "input_image", "image_url": "data:image/png;base64,first"},
            {"type": "input_image", "image_url": "data:image/png;base64,second"},
        ],
        attachments=[
            {
                "id": 15,
                "original_filename": "first.png",
                "mime_type": "image/png",
                "file_size": 3,
                "subtask_id": 43,
            },
            {
                "id": 16,
                "original_filename": "second.png",
                "mime_type": "image/png",
                "file_size": 3,
                "subtask_id": 43,
            },
        ],
    )
    agent = CodeXAgent(request, MagicMock())

    def fake_download_all(self, attachments):
        return AttachmentDownloadResult(
            success=[{**attachments[1], "local_path": str(second_image)}],
            failed=[{**attachments[0], "error": "HTTP 404"}],
        )

    monkeypatch.setattr(
        "executor.services.attachment_downloader.AttachmentDownloader.download_all",
        fake_download_all,
    )

    agent._process_attachments_for_codex()
    turn_input = agent._build_turn_input()

    assert [type(item).__name__ for item in turn_input] == [
        "TextInput",
        "ImageInput",
        "LocalImageInput",
    ]
    assert turn_input[0].text == (
        "\n# Files mentioned by the user:\n\n"
        f"## second.png: {second_image}\n\n"
        "## My request for Codex:\n"
        "Compare these images\n"
    )
    assert turn_input[1].url == "data:image/png;base64,first"
    assert turn_input[2].path == str(second_image)
