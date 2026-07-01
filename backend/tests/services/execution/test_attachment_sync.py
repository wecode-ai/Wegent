# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for executor attachment sync prompt updates."""

from app.services.execution.attachment_sync import (
    apply_attachment_sync_response,
    rewrite_prompt_with_synced_attachments,
)
from shared.models import AttachmentSyncItem, AttachmentSyncResponse, ExecutionRequest


def test_rewrite_prompt_with_synced_attachments_updates_image_sandbox_path():
    prompt = [
        {
            "type": "input_text",
            "text": (
                "<attachment>"
                "[Image Attachment: image.png | ID: 17 | Type: image/png | "
                "Size: 1.0 KB | URL: /api/attachments/17/download | "
                "File Path in Sandbox: /home/user/78:executor:attachments/213/image.png]"
                "</attachment>"
            ),
        },
        {"type": "input_text", "text": "看下这个图"},
    ]

    rewritten = rewrite_prompt_with_synced_attachments(
        prompt=prompt,
        task_id=78,
        default_subtask_id=213,
        attachments=[
            {
                "id": 17,
                "original_filename": "image.png",
                "status": "success",
                "local_path": "/workspace/78/78:executor:attachments/213/image.png",
                "mime_type": "image/png",
                "subtask_id": 213,
            }
        ],
    )

    assert isinstance(rewritten, list)
    assert (
        "/home/user/78:executor:attachments/213/image.png" not in rewritten[0]["text"]
    )
    assert (
        "Local File Path: /workspace/78/78:executor:attachments/213/image.png"
        in rewritten[0]["text"]
    )
    assert rewritten[1]["text"] == "看下这个图"


def test_rewrite_prompt_with_synced_attachments_updates_document_path_and_marker():
    prompt = (
        "please inspect [attachment:16]\n"
        "File Path(already in sandbox): "
        "/home/user/78:executor:attachments/211/archive.zip"
    )

    rewritten = rewrite_prompt_with_synced_attachments(
        prompt=prompt,
        task_id=78,
        default_subtask_id=211,
        attachments=[
            {
                "id": 16,
                "original_filename": "archive.zip",
                "status": "success",
                "local_path": "/workspace/78/78:executor:attachments/211/archive.zip",
                "subtask_id": 211,
            }
        ],
    )

    assert isinstance(rewritten, str)
    assert (
        "[Attachment downloaded to: "
        "/workspace/78/78:executor:attachments/211/archive.zip]" in rewritten
    )
    assert (
        "Local File Path: /workspace/78/78:executor:attachments/211/archive.zip"
        in rewritten
    )


def test_apply_attachment_sync_response_updates_request_prompt_and_runtime_identity():
    request = ExecutionRequest(
        task_id=78,
        subtask_id=214,
        user_subtask_id=213,
        executor_name="old",
        prompt=(
            "[Image Attachment: image.png | ID: 17 | Type: image/png | "
            "Size: 1.0 KB | URL: /api/attachments/17/download | "
            "File Path in Sandbox: /home/user/78:executor:attachments/213/image.png]"
        ),
    )
    response = AttachmentSyncResponse(
        task_id=78,
        subtask_id=214,
        executor_name="wegent-task-user-abc",
        attachments=[
            AttachmentSyncItem(
                id=17,
                original_filename="image.png",
                status="success",
                local_path="/workspace/78/78:executor:attachments/213/image.png",
                subtask_id=213,
            )
        ],
    )

    apply_attachment_sync_response(request, response)

    assert request.executor_name == "wegent-task-user-abc"
    assert request.attachments[0]["local_path"].endswith("/213/image.png")
    assert "/home/user/78:executor:attachments/213/image.png" not in request.prompt
    assert (
        "Local File Path: /workspace/78/78:executor:attachments/213/image.png"
        in request.prompt
    )


def test_rewrite_prompt_with_failed_attachment_warns_once_for_content_blocks():
    prompt = [
        {"type": "input_text", "text": "open [attachment:17]"},
        {"type": "input_text", "text": "then explain"},
    ]

    rewritten = rewrite_prompt_with_synced_attachments(
        prompt=prompt,
        task_id=78,
        default_subtask_id=213,
        attachments=[
            {
                "id": 17,
                "original_filename": "image.png",
                "status": "failed",
                "error": "missing auth_token",
                "subtask_id": 213,
            }
        ],
    )

    assert isinstance(rewritten, list)
    combined = "\n".join(block["text"] for block in rewritten)
    assert "[Attachment 17 unavailable - download failed]" in combined
    assert combined.count("failed to download") == 1
