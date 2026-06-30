# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Client for preparing attachments inside executor runtimes."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

import httpx

from app.core.config import settings
from shared.models import (
    AttachmentSyncRequest,
    AttachmentSyncResponse,
    ExecutionRequest,
)
from shared.utils.attachment_block import build_sandbox_path

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _AttachmentPromptUpdate:
    """Resolved attachment state used to update user-visible prompt text."""

    id: int
    original_filename: str
    local_path: str | None
    status: str | None
    error: str | None
    subtask_id: int | None


def _format_http_error(error: Exception) -> str:
    """Build a stable error string from executor-manager HTTP failures."""
    if isinstance(error, httpx.HTTPStatusError):
        response = error.response
        detail = ""
        try:
            payload = response.json()
        except (ValueError, json.JSONDecodeError):
            payload = None
        if isinstance(payload, dict):
            detail = (
                payload.get("detail")
                or payload.get("error_msg")
                or payload.get("message")
                or ""
            )
        if not detail:
            detail = response.text or str(error)
        return (
            f"executor-manager attachment sync failed: "
            f"status={response.status_code} detail={detail}"
        )
    return str(error)


async def sync_executor_attachments(
    request: ExecutionRequest,
) -> AttachmentSyncResponse:
    """Synchronize request attachments to the target executor runtime."""
    sync_request = AttachmentSyncRequest.from_execution_request(request)
    if not sync_request.attachments:
        return AttachmentSyncResponse(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            executor_name=request.executor_name,
            executor_namespace=request.executor_namespace,
        )

    base_url = settings.EXECUTOR_MANAGER_URL.rstrip("/")
    url = (
        f"{base_url}/executor-manager/tasks/" f"{sync_request.task_id}/attachments/sync"
    )
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            response = await client.post(
                url,
                json=sync_request.to_dict(),
                headers={"Content-Type": "application/json"},
            )
            response.raise_for_status()
            sync_response = AttachmentSyncResponse.from_dict(response.json())
            logger.info(
                "[attachment_sync] Synced attachments: task_id=%s, "
                "subtask_id=%s, executor_name=%s, success_count=%d, failed_count=%d",
                request.task_id,
                request.subtask_id,
                sync_response.executor_name,
                sync_response.success_count,
                sync_response.failed_count,
            )
            return sync_response
    except Exception as e:
        error = _format_http_error(e)
        logger.error(
            "[attachment_sync] Failed to sync attachments: task_id=%s, "
            "subtask_id=%s, attachments=%d, error=%s",
            request.task_id,
            request.subtask_id,
            len(sync_request.attachments),
            error,
        )
        return AttachmentSyncResponse.failed_for_request(sync_request, error)


def apply_attachment_sync_response(
    request: ExecutionRequest,
    response: AttachmentSyncResponse,
) -> None:
    """Merge sync results back into the request used for formal execution."""
    if response.executor_name:
        request.executor_name = response.executor_name
    if response.executor_namespace:
        request.executor_namespace = response.executor_namespace
    request.attachments = [item.to_dict() for item in response.attachments]
    request.prompt = rewrite_prompt_with_synced_attachments(
        prompt=request.prompt,
        task_id=request.task_id,
        default_subtask_id=request.user_subtask_id or response.subtask_id,
        attachments=request.attachments,
    )


def rewrite_prompt_with_synced_attachments(
    *,
    prompt: str | list[dict[str, Any]],
    task_id: int,
    default_subtask_id: int | None,
    attachments: list[dict[str, Any]],
) -> str | list[dict[str, Any]]:
    """Rewrite attachment references in the prompt with executor-local paths."""
    updates = [_prompt_update(item) for item in attachments if isinstance(item, dict)]
    if not updates:
        return prompt

    failed_updates = [item for item in updates if _is_failed(item)]
    if isinstance(prompt, str):
        return _rewrite_prompt_text(
            prompt,
            task_id=task_id,
            default_subtask_id=default_subtask_id,
            updates=updates,
            failed_updates=failed_updates,
            append_failures=True,
        )

    if not isinstance(prompt, list):
        return prompt

    failure_appended = False
    rewritten_blocks: list[dict[str, Any]] = []
    for block in prompt:
        if not isinstance(block, dict):
            rewritten_blocks.append(block)
            continue

        block_type = block.get("type")
        text = block.get("text")
        if block_type not in {"input_text", "text"} or not isinstance(text, str):
            rewritten_blocks.append(block)
            continue

        updated_block = dict(block)
        updated_block["text"] = _rewrite_prompt_text(
            text,
            task_id=task_id,
            default_subtask_id=default_subtask_id,
            updates=updates,
            failed_updates=failed_updates,
            append_failures=not failure_appended,
        )
        failure_appended = failure_appended or bool(failed_updates)
        rewritten_blocks.append(updated_block)

    return rewritten_blocks


def _prompt_update(data: dict[str, Any]) -> _AttachmentPromptUpdate:
    return _AttachmentPromptUpdate(
        id=int(data.get("id") or 0),
        original_filename=(
            data.get("original_filename")
            or data.get("originalFilename")
            or data.get("filename")
            or data.get("name")
            or "attachment"
        ),
        local_path=data.get("local_path") or data.get("localPath"),
        status=data.get("status"),
        error=data.get("error"),
        subtask_id=data.get("subtask_id") or data.get("subtaskId"),
    )


def _rewrite_prompt_text(
    text: str,
    *,
    task_id: int,
    default_subtask_id: int | None,
    updates: list[_AttachmentPromptUpdate],
    failed_updates: list[_AttachmentPromptUpdate],
    append_failures: bool,
) -> str:
    rewritten = _replace_attachment_short_refs(text, updates)
    for update in updates:
        if _is_failed(update) or not update.local_path:
            continue
        sandbox_path = build_sandbox_path(
            task_id,
            update.subtask_id or default_subtask_id,
            update.original_filename,
        )
        if not sandbox_path:
            continue
        rewritten = rewritten.replace(
            f"File Path(already in sandbox): {sandbox_path}",
            f"Local File Path: {update.local_path}",
        )
        rewritten = rewritten.replace(
            f"File Path in Sandbox: {sandbox_path}",
            f"Local File Path: {update.local_path}",
        )
        rewritten = rewritten.replace(sandbox_path, update.local_path)

    if append_failures:
        rewritten = _append_failed_attachment_warning(rewritten, failed_updates)
    return rewritten


def _replace_attachment_short_refs(
    text: str,
    updates: list[_AttachmentPromptUpdate],
) -> str:
    rewritten = text
    by_id = {item.id: item for item in updates}
    for attachment_id, update in by_id.items():
        marker = f"[attachment:{attachment_id}]"
        if marker not in rewritten:
            continue
        if update.local_path and not _is_failed(update):
            replacement = f"[Attachment downloaded to: {update.local_path}]"
        elif _is_failed(update):
            replacement = f"[Attachment {attachment_id} unavailable - download failed]"
        else:
            replacement = f"[Attachment {attachment_id} unavailable]"
        rewritten = rewritten.replace(marker, replacement)
    return rewritten


def _append_failed_attachment_warning(
    text: str,
    failed_updates: list[_AttachmentPromptUpdate],
) -> str:
    if not failed_updates:
        return text
    lines = [
        "",
        "",
        "The following attachments failed to download and are unavailable:",
    ]
    for update in failed_updates:
        lines.append(
            f"- {update.original_filename} (Error: {update.error or 'Unknown error'})"
        )
    return text + "\n".join(lines)


def _is_failed(update: _AttachmentPromptUpdate) -> bool:
    return (update.status or "").lower() == "failed" or bool(update.error)
