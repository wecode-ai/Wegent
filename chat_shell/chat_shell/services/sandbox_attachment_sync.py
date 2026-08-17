# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Prepare Chat Shell attachments in the task sandbox before model execution."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from chat_shell.core.config import settings
from shared.models.execution import ExecutionRequest
from shared.telemetry.decorators import add_span_event, trace_async
from shared.utils.attachment_block import (
    build_attachment_download_url,
    build_sandbox_path,
)

logger = logging.getLogger(__name__)

_SANDBOX_SKILL_NAME = "sandbox"
_ATTACHMENT_DOWNLOAD_TIMEOUT = 180.0


def _skill_name(value: Any) -> str:
    """Return a normalized skill name from a name or skill config."""
    if isinstance(value, str):
        return value.strip().lower()
    if isinstance(value, dict):
        return str(value.get("name") or "").strip().lower()
    return ""


def _sandbox_skill_available(request: ExecutionRequest) -> bool:
    """Return whether this request can expose sandbox-backed attachment paths."""
    configured_skills = (
        list(request.skill_names or [])
        + list(request.preload_skills or [])
        + list(request.user_selected_skills or [])
        + list(request.skill_configs or [])
    )
    return any(_skill_name(item) == _SANDBOX_SKILL_NAME for item in configured_skills)


def _sandbox_skill_config(request: ExecutionRequest) -> dict[str, Any]:
    """Return the provider config used by the sandbox tools themselves."""
    for skill_config in request.skill_configs or []:
        if _skill_name(skill_config) != _SANDBOX_SKILL_NAME:
            continue
        config = skill_config.get("config") if isinstance(skill_config, dict) else None
        return config if isinstance(config, dict) else {}
    return {}


def _backend_url(request: ExecutionRequest) -> str:
    """Resolve the Backend base URL without any trailing API suffix.

    Callers append ``/api/attachments/...`` themselves, so the base must not
    already carry an ``/api`` or ``/api/internal`` suffix; otherwise the request
    doubles up to ``/api/api/...`` and returns 404.
    """
    url = (request.backend_url or settings.REMOTE_STORAGE_URL).rstrip("/")
    for suffix in ("/api/internal", "/api"):
        if url.endswith(suffix):
            return url[: -len(suffix)]
    return url


def _integer(value: Any, default: int = 0) -> int:
    """Coerce trusted request metadata without aborting the entire chat."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _attachment_value(attachment: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = attachment.get(key)
        if value is not None:
            return value
    return None


def _attachment_filename(attachment: dict[str, Any]) -> str:
    return str(
        _attachment_value(
            attachment,
            "original_filename",
            "originalFilename",
            "filename",
            "name",
        )
        or "attachment"
    )


def _attachment_subtask_id(
    request: ExecutionRequest, attachment: dict[str, Any]
) -> int:
    value = _attachment_value(attachment, "subtask_id", "subtaskId")
    return _integer(value or request.user_subtask_id or request.subtask_id)


def _failed_attachment_prompt(
    prompt: str | list[dict[str, Any]],
    failed_attachments: list[dict[str, Any]],
) -> str | list[dict[str, Any]]:
    """Stop claiming failed attachments are already present in the sandbox."""
    if not failed_attachments:
        return prompt

    warning = _failed_attachment_warning(failed_attachments)

    def rewrite(text: str, *, append_warning: bool) -> str:
        rewritten = _rewrite_failed_attachment_paths(text, failed_attachments)
        return rewritten + warning if append_warning else rewritten

    if isinstance(prompt, str):
        return rewrite(prompt, append_warning=True)
    if not isinstance(prompt, list):
        return prompt

    warning_appended = False
    rewritten_blocks: list[dict[str, Any]] = []
    for block in prompt:
        if not isinstance(block, dict):
            rewritten_blocks.append(block)
            continue
        text = block.get("text")
        if block.get("type") not in {"input_text", "text"} or not isinstance(text, str):
            rewritten_blocks.append(block)
            continue
        updated = dict(block)
        updated["text"] = rewrite(text, append_warning=not warning_appended)
        warning_appended = True
        rewritten_blocks.append(updated)
    return rewritten_blocks


def _rewrite_failed_attachment_paths(
    text: str, failed_attachments: list[dict[str, Any]]
) -> str:
    rewritten = text
    for attachment in failed_attachments:
        path = str(attachment.get("local_path") or "")
        if not path:
            continue
        rewritten = rewritten.replace(
            f"File Path(already in sandbox): {path}",
            f"File Path(not synchronized): {path}",
        )
        rewritten = rewritten.replace(
            f"File Path in Sandbox: {path}",
            f"File Path(not synchronized): {path}",
        )
    return rewritten


def _failed_attachment_warning(failed_attachments: list[dict[str, Any]]) -> str:
    lines = [
        "",
        "",
        "The following attachments are not yet synchronized to the sandbox:",
    ]
    for attachment in failed_attachments:
        attachment_id = _integer(attachment.get("id"))
        filename = _attachment_filename(attachment)
        path = str(attachment.get("local_path") or "")
        download_url = build_attachment_download_url(attachment_id)
        lines.append(
            f"- {filename} (ID: {attachment_id}). Use download_attachment with "
            f"attachment_url={download_url}; it will save to {path}."
        )
    return "\n".join(lines)


def _mark_all_failed(
    request: ExecutionRequest, attachments: list[dict[str, Any]], error: str
) -> None:
    failed: list[dict[str, Any]] = []
    for attachment in attachments:
        updated = dict(attachment)
        filename = _attachment_filename(updated)
        subtask_id = _attachment_subtask_id(request, updated)
        updated.update(
            {
                "status": "failed",
                "error": error,
                "local_path": build_sandbox_path(request.task_id, subtask_id, filename),
                "subtask_id": subtask_id,
            }
        )
        failed.append(updated)
    request.attachments = failed
    request.prompt = _failed_attachment_prompt(request.prompt, failed)


async def _file_already_synced(
    sandbox: Any, path: str, expected_size: int | None
) -> bool:
    """Return whether a sandbox file already exists with the expected size."""
    if not expected_size or expected_size < 0:
        return False
    try:
        file_info = await sandbox.files.get_info(path)
    except Exception:
        return False
    return int(file_info.size) == expected_size


async def _sync_one_attachment(
    *,
    client: httpx.AsyncClient,
    sandbox: Any,
    request: ExecutionRequest,
    attachment: dict[str, Any],
    backend_url: str,
) -> dict[str, Any]:
    """Download one attachment through task-token auth and write it to sandbox."""
    updated = dict(attachment)
    attachment_id = _integer(updated.get("id"))
    filename = _attachment_filename(updated)
    subtask_id = _attachment_subtask_id(request, updated)
    local_path = build_sandbox_path(request.task_id, subtask_id, filename)
    updated.update({"local_path": local_path, "subtask_id": subtask_id})

    if attachment_id <= 0 or not local_path:
        updated.update({"status": "failed", "error": "Invalid attachment metadata"})
        return updated

    raw_size = _attachment_value(updated, "file_size", "fileSize")
    expected_size = _integer(raw_size, default=-1) if raw_size is not None else None
    if await _file_already_synced(sandbox, local_path, expected_size):
        updated.update({"status": "success", "error": None})
        return updated

    url = f"{backend_url}/api/attachments/{attachment_id}/executor-download"
    try:
        response = await client.get(
            url,
            headers={"Authorization": f"Bearer {request.auth_token}"},
        )
        response.raise_for_status()
        parent_dir = local_path.rsplit("/", 1)[0]
        try:
            await sandbox.files.make_dir(parent_dir)
        except Exception:
            logger.debug(
                "[sandbox_attachment_sync] Parent directory already exists: %s",
                parent_dir,
            )
        await sandbox.files.write(local_path, response.content)
        updated.update({"status": "success", "error": None})
    except httpx.HTTPStatusError as exc:
        updated.update(
            {
                "status": "failed",
                "error": f"Attachment download returned HTTP {exc.response.status_code}",
            }
        )
    except Exception as exc:
        updated.update({"status": "failed", "error": str(exc)})
    return updated


async def _create_task_sandbox(request: ExecutionRequest) -> tuple[Any, str | None]:
    """Create or reconnect to the sandbox using the active skill's config."""
    from chat_shell.tools.sandbox._base import SandboxManager

    sandbox_config = _sandbox_skill_config(request)
    manager = SandboxManager.get_instance(
        task_id=request.task_id,
        user_id=request.user_id,
        user_name=request.user_name,
        bot_config=sandbox_config.get("bot_config", []),
        auth_token=request.auth_token,
        skill_identity_token=request.skill_identity_token,
    )
    return await manager.get_or_create_sandbox(
        shell_type=sandbox_config.get("default_shell_type", "ClaudeCode"),
        workspace_ref=None,
        task_type="sandbox",
    )


async def _sync_attachments(
    request: ExecutionRequest,
    sandbox: Any,
    attachments: list[dict[str, Any]],
    client: httpx.AsyncClient,
) -> list[dict[str, Any]]:
    backend_url = _backend_url(request)
    return [
        await _sync_one_attachment(
            client=client,
            sandbox=sandbox,
            request=request,
            attachment=attachment,
            backend_url=backend_url,
        )
        for attachment in attachments
    ]


async def _load_task_attachments(
    *,
    client: httpx.AsyncClient,
    request: ExecutionRequest,
    backend_url: str,
) -> list[dict[str, Any]]:
    """Load trusted metadata for current and historical task attachments."""
    url = f"{backend_url}/api/attachments/task/{request.task_id}/all"
    response = await client.get(
        url,
        headers={"Authorization": f"Bearer {request.auth_token}"},
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, list):
        raise ValueError("Backend returned invalid task attachment metadata")
    return [dict(item) for item in payload if isinstance(item, dict)]


def _merge_attachments(
    task_attachments: list[dict[str, Any]],
    current_attachments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Merge task metadata with the richer current-turn attachment payload."""
    merged: dict[int, dict[str, Any]] = {}
    invalid: list[dict[str, Any]] = []
    for attachment in task_attachments:
        attachment_id = _integer(attachment.get("id"))
        if attachment_id <= 0:
            continue
        merged[attachment_id] = dict(attachment)
    for attachment in current_attachments:
        attachment_id = _integer(attachment.get("id"))
        if attachment_id <= 0:
            invalid.append(dict(attachment))
            continue
        merged[attachment_id] = {**merged.get(attachment_id, {}), **attachment}
    return [*merged.values(), *invalid]


@trace_async(
    span_name="chat_service.sync_sandbox_attachments",
    tracer_name="chat_shell.services",
    extract_attributes=lambda request, *args, **kwargs: {
        "attachment.task_id": request.task_id,
        "attachment.subtask_id": request.subtask_id,
        "attachment.count": len(request.attachments or []),
    },
)
async def sync_chat_attachments_to_sandbox(request: ExecutionRequest) -> None:
    """Synchronize task attachments before the model can use sandbox tools."""
    current_attachments = [
        dict(item) for item in (request.attachments or []) if isinstance(item, dict)
    ]
    if not _sandbox_skill_available(request):
        return

    if not request.auth_token:
        _mark_all_failed(
            request,
            current_attachments,
            "Task authentication token is missing",
        )
        return

    backend_url = _backend_url(request)
    async with httpx.AsyncClient(
        timeout=_ATTACHMENT_DOWNLOAD_TIMEOUT,
        follow_redirects=True,
    ) as client:
        try:
            task_attachments = await _load_task_attachments(
                client=client,
                request=request,
                backend_url=backend_url,
            )
        except Exception as exc:
            task_attachments = []
            logger.warning(
                "[sandbox_attachment_sync] Failed to load task attachments: "
                "task_id=%s, error=%s",
                request.task_id,
                exc,
            )

        attachments = _merge_attachments(task_attachments, current_attachments)
        if not attachments:
            return

        # Import and initialize E2B only after finding attachments to synchronize.
        sandbox, error = await _create_task_sandbox(request)
        if error or sandbox is None:
            _mark_all_failed(request, attachments, error or "Sandbox is unavailable")
            return

        synced = await _sync_attachments(request, sandbox, attachments, client)
    request.attachments = synced
    failed = [item for item in synced if item.get("status") == "failed"]
    request.prompt = _failed_attachment_prompt(request.prompt, failed)
    add_span_event(
        "sandbox_attachments_synced",
        {
            "success_count": len(synced) - len(failed),
            "failed_count": len(failed),
        },
    )
    logger.info(
        "[sandbox_attachment_sync] Completed: task_id=%s, subtask_id=%s, "
        "success_count=%s, failed_count=%s",
        request.task_id,
        request.subtask_id,
        len(synced) - len(failed),
        len(failed),
    )
