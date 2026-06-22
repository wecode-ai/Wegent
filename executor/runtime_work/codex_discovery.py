# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Discover Codex sessions as device-local runtime work items."""

import contextlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from executor.agents.codex.config_builder import _resolve_codex_binary
from executor.config import config
from executor.runtime_work.local_task_store import (
    LocalTaskRecord,
    normalize_workspace_path,
    utc_now_iso,
)
from shared.logger import setup_logger

DEFAULT_CODEX_SESSION_LIMIT = 100

logger = setup_logger("codex_session_discovery")


class CodexSessionDiscovery:
    """Read Codex SDK thread metadata and expose user sessions as LocalTasks."""

    def __init__(
        self,
        codex_home: Optional[Path] = None,
        limit: int = DEFAULT_CODEX_SESSION_LIMIT,
        codex_client_factory: Optional[Callable[[], Any]] = None,
    ):
        self.codex_home = Path(
            codex_home or os.environ.get("CODEX_HOME") or (Path.home() / ".codex")
        ).expanduser()
        self.limit = max(1, limit)
        self.codex_client_factory = codex_client_factory

    def discover(self) -> list[LocalTaskRecord]:
        try:
            records = self._discover_with_sdk()
        except Exception:
            logger.exception("Failed to list Codex threads through SDK")
            return []

        return _sort_local_tasks(records)

    def _discover_with_sdk(self) -> list[LocalTaskRecord]:
        client = self._create_codex_client()
        with client as codex:
            response = codex.thread_list(
                limit=self.limit,
                archived=False,
                sort_direction=_codex_enum_value("SortDirection", "desc"),
                sort_key=_codex_enum_value("ThreadSortKey", "updated_at"),
                use_state_db_only=True,
            )

        return [
            task
            for task in (
                _thread_to_local_task(thread)
                for thread in getattr(response, "data", [])
            )
            if task is not None
        ]

    def _create_codex_client(self) -> Any:
        if self.codex_client_factory is not None:
            return self.codex_client_factory()

        from openai_codex import Codex, CodexConfig

        return Codex(self._codex_config(CodexConfig))

    def _create_async_codex_client(self) -> Any:
        from openai_codex import AsyncCodex, CodexConfig

        return AsyncCodex(self._codex_config(CodexConfig))

    def _create_async_codex_client_with_config(self, codex_config: Any) -> Any:
        from openai_codex import AsyncCodex

        return AsyncCodex(config=codex_config)

    def _codex_config_type(self) -> Any:
        from openai_codex import CodexConfig

        return CodexConfig

    def _codex_config(self, config_type: Any) -> Any:
        return config_type(
            codex_bin=_resolve_codex_binary(config.CODEX_BINARY_PATH),
            client_name="wegent_executor",
            client_title="Wegent Executor",
            env={**os.environ, "CODEX_HOME": str(self.codex_home)},
        )

    def read_transcript(
        self,
        thread_id: str,
        session_path: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        path = self._resolve_session_path(thread_id, session_path)
        if path is None:
            return []
        return _read_session_transcript(path, thread_id)

    def _resolve_session_path(
        self,
        thread_id: str,
        session_path: Optional[str],
    ) -> Optional[Path]:
        if session_path:
            path = Path(session_path).expanduser()
            if path.is_file():
                return path

        for path in _iter_session_files(self.codex_home, thread_id):
            return path
        return None

    def archive_thread(self, thread_id: str) -> None:
        client = self._create_codex_client()
        with client as codex:
            codex.thread_archive(thread_id)

    async def stream_message(
        self,
        thread_id: str,
        message: str,
        *,
        cwd: Optional[str] = None,
        emitter: Any,
    ) -> None:
        """Continue a Codex thread and emit the SDK turn stream."""

        from executor.agents.codex.codex_agent import _full_access_sandbox
        from executor.agents.codex.event_mapper import CodeXEventMapper

        client = self._create_async_codex_client()
        async with client as codex:
            thread = await codex.thread_resume(thread_id, cwd=cwd)
            mapper = CodeXEventMapper(emitter)
            await emitter.start(shell_type="Codex")
            turn = await thread.turn(
                message,
                cwd=cwd,
                sandbox=_full_access_sandbox(),
            )
            async for event in turn.stream():
                status = await mapper.handle(event)
                if status is not None:
                    return

        await emitter.error("Codex turn ended without completion", "execution_error")

    async def stream_new_thread(
        self,
        request: Any,
        message: str,
        *,
        cwd: Optional[str] = None,
        emitter_factory: Callable[[str], Any],
    ) -> None:
        """Start a new Codex thread and emit the SDK turn stream."""

        from executor.agents.codex.attachment_handler import process_codex_attachments
        from executor.agents.codex.codex_agent import (
            _deny_all_approval_mode,
            _full_access_sandbox,
        )
        from executor.agents.codex.config_builder import build_codex_config
        from executor.agents.codex.event_mapper import CodeXEventMapper
        from executor.modes.local.capabilities import get_project_id

        codex_config = build_codex_config(
            request.model_config,
            project_id=get_project_id(request),
        )
        client_config = self._codex_config_type()(
            codex_bin=codex_config.codex_bin,
            config_overrides=codex_config.config_overrides,
            cwd=cwd,
            env=_codex_env(self.codex_home, codex_config.env),
        )
        client = self._create_async_codex_client_with_config(client_config)
        attachment_result = process_codex_attachments(
            task_data=request,
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            prompt=message,
        )
        emitter = None
        try:
            try:
                async with client as codex:
                    thread = await codex.thread_start(
                        **_thread_start_kwargs(
                            approval_mode=_deny_all_approval_mode(),
                            codex_config=codex_config,
                            cwd=cwd,
                            developer_instructions=_developer_instructions(request),
                            sandbox=_full_access_sandbox(),
                        ),
                    )
                    thread_id = _object_text(thread, "id", "session_id")
                    if not thread_id:
                        raise RuntimeError(
                            "Codex thread_start did not return a threadId"
                        )

                    emitter = emitter_factory(thread_id)
                    mapper = CodeXEventMapper(
                        emitter,
                        executor_session_provider=lambda: {
                            "agent": "CodeX",
                            "threadId": thread_id,
                        },
                    )
                    await emitter.start(shell_type="Codex")
                    turn = await thread.turn(
                        _codex_turn_input(
                            attachment_result.prompt,
                            attachment_result.local_image_paths,
                        ),
                        cwd=cwd,
                        model=codex_config.model,
                        sandbox=_full_access_sandbox(),
                        **_turn_reasoning_kwargs(codex_config),
                    )
                    async for event in turn.stream():
                        status = await mapper.handle(event)
                        if status is not None:
                            return

                await emitter.error(
                    "Codex turn ended without completion", "execution_error"
                )
            except Exception as exc:
                if emitter is None:
                    raise
                await emitter.error(str(exc), "execution_error")
        finally:
            _cleanup_paths(attachment_result.model_input_files)


def _thread_to_local_task(thread: Any) -> Optional[LocalTaskRecord]:
    thread_id = _object_text(thread, "id", "session_id")
    cwd = _object_text(thread, "cwd")
    if not thread_id or not cwd:
        return None

    created_at = (
        _codex_time_to_iso(_first_object_value(thread, "created_at", "createdAt"))
        or utc_now_iso()
    )
    updated_at = (
        _codex_time_to_iso(_first_object_value(thread, "updated_at", "updatedAt"))
        or created_at
    )
    session_path = _object_text(thread, "path")
    runtime_handle = {
        "threadId": thread_id,
        "sessionPath": session_path,
    }
    git_info = _thread_git_info(thread)
    if git_info:
        runtime_handle["gitInfo"] = git_info
    return LocalTaskRecord(
        local_task_id=thread_id,
        workspace_path=normalize_workspace_path(cwd),
        title=_thread_title(thread, thread_id),
        runtime="codex",
        runtime_handle=runtime_handle,
        created_at=created_at,
        updated_at=updated_at,
        running=_is_thread_running(thread),
        status="active",
    )


def _thread_title(thread: Any, thread_id: str) -> str:
    title = _object_text(thread, "name", "preview", "title")
    return title or thread_id


def _is_thread_running(thread: Any) -> bool:
    status = _object_value(thread, "status")
    if status is None:
        return False
    if isinstance(status, str):
        status_type = status
    else:
        status_type = _object_text(status, "type", "status")

    normalized = (status_type or "").replace("_", "").lower()
    return normalized not in ("", "notloaded", "completed", "archived", "idle")


def _thread_git_info(thread: Any) -> Optional[dict[str, Any]]:
    git_info = _first_object_value(thread, "git_info", "gitInfo")
    if git_info is None:
        return None
    if isinstance(git_info, dict):
        payload = git_info
    elif hasattr(git_info, "model_dump"):
        payload = git_info.model_dump(mode="json", by_alias=True, exclude_none=True)
    else:
        payload = {
            "branch": _object_value(git_info, "branch"),
            "originUrl": _first_object_value(git_info, "origin_url", "originUrl"),
            "sha": _object_value(git_info, "sha"),
        }

    normalized: dict[str, Any] = {}
    for source_key, target_key in (
        ("branch", "branch"),
        ("origin_url", "originUrl"),
        ("originUrl", "originUrl"),
        ("sha", "sha"),
    ):
        value = payload.get(source_key)
        if isinstance(value, str) and value.strip():
            normalized[target_key] = value.strip()
    return normalized or None


def _first_object_value(value: Any, *names: str) -> Any:
    for name in names:
        raw = _object_value(value, name)
        if raw is not None:
            return raw
    return None


def _object_value(value: Any, *names: str) -> Any:
    current = value
    for name in names:
        if isinstance(current, dict):
            current = current.get(name)
        else:
            current = getattr(current, name, None)
    return current


def _object_text(value: Any, *names: str) -> Optional[str]:
    for name in names:
        raw = _object_value(value, name)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
        root = _object_value(raw, "root")
        if isinstance(root, str) and root.strip():
            return root.strip()
    return None


def _codex_time_to_iso(value: Any) -> Optional[str]:
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, timezone.utc).isoformat()
    if isinstance(value, str) and value.strip():
        parsed = _parse_datetime(value.strip())
        return parsed.isoformat() if parsed else value.strip()
    return None


def _codex_enum_value(enum_name: str, value: str) -> Any:
    try:
        from openai_codex.generated import v2_all

        enum_type = getattr(v2_all, enum_name)
        return enum_type(value)
    except (ImportError, AttributeError, TypeError, ValueError):
        return value


def _codex_env(
    codex_home: Path, runtime_env: Optional[dict[str, str]]
) -> dict[str, str]:
    env = {**os.environ, "CODEX_HOME": str(codex_home)}
    if runtime_env:
        env.update(runtime_env)
    return env


def _developer_instructions(request: Any) -> Optional[str]:
    parts = [
        str(getattr(request, "system_prompt", "") or ""),
        str(getattr(request, "kb_meta_prompt", "") or ""),
    ]
    content = "\n\n".join(part for part in parts if part.strip())
    return content or None


def _thread_start_kwargs(
    *,
    approval_mode: Any,
    codex_config: Any,
    cwd: Optional[str],
    developer_instructions: Optional[str],
    sandbox: Any,
) -> dict[str, Any]:
    kwargs = {
        "approval_mode": approval_mode,
        "config": codex_config.thread_config,
        "developer_instructions": developer_instructions,
        "model": codex_config.model,
        "sandbox": sandbox,
        "service_name": "wegent",
    }
    if cwd:
        kwargs["cwd"] = cwd
    if codex_config.model_provider:
        kwargs["model_provider"] = codex_config.model_provider
    return kwargs


def _turn_reasoning_kwargs(codex_config: Any) -> dict[str, Any]:
    kwargs: dict[str, Any] = {}
    if codex_config.effort:
        effort = _reasoning_effort(codex_config.effort)
        if effort is not None:
            kwargs["effort"] = effort
    if codex_config.summary:
        summary = _reasoning_summary(codex_config.summary)
        if summary is not None:
            kwargs["summary"] = summary
    return kwargs


def _reasoning_effort(value: str) -> Any:
    try:
        from openai_codex.generated.v2_all import ReasoningEffort

        return ReasoningEffort(value)
    except (ImportError, TypeError, ValueError):
        logger.warning("Unsupported Codex reasoning effort: %s", value)
        return None


def _reasoning_summary(value: Any) -> Any:
    try:
        from openai_codex.generated.v2_all import ReasoningSummary

        return ReasoningSummary.model_validate(value)
    except (ImportError, AttributeError, TypeError, ValueError):
        logger.warning("Unsupported Codex reasoning summary: %s", value)
        return None


def _codex_turn_input(prompt: Any, local_image_paths: list[str | None]) -> Any:
    if not any(local_image_paths):
        return prompt

    from openai_codex import LocalImageInput, TextInput

    prompt_text = prompt if isinstance(prompt, str) else str(prompt)
    items: list[Any] = [
        TextInput(_build_files_mentioned_text(prompt_text, local_image_paths))
    ]
    items.extend(LocalImageInput(path) for path in local_image_paths if path)
    return items


def _build_files_mentioned_text(
    prompt: str,
    local_image_paths: list[str | None],
) -> str:
    file_lines = "\n".join(
        f"## {os.path.basename(path)}: {path}" for path in local_image_paths if path
    )
    return (
        "\n# Files mentioned by the user:\n\n"
        f"{file_lines}\n\n"
        "## My request for Codex:\n"
        f"{_strip_attachment_warnings(_strip_attachment_blocks(prompt)).strip()}\n"
    )


def _strip_attachment_blocks(text: str) -> str:
    remaining = text
    while True:
        start = remaining.find("<attachment>")
        if start < 0:
            return remaining
        end = remaining.find("</attachment>", start)
        if end < 0:
            return remaining
        remaining = remaining[:start] + remaining[end + len("</attachment>") :]


def _strip_attachment_warnings(text: str) -> str:
    warning_marker = "\n\n⚠️ The following attachments failed to download"
    marker_index = text.find(warning_marker)
    if marker_index < 0:
        return text
    return text[:marker_index]


def _cleanup_paths(paths: list[str]) -> None:
    for path in paths:
        with contextlib.suppress(OSError):
            os.unlink(path)


def _sort_local_tasks(records: list[LocalTaskRecord]) -> list[LocalTaskRecord]:
    return sorted(
        records,
        key=lambda record: _parse_datetime(record.updated_at)
        or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )


def _parse_json_line(value: Any) -> Optional[dict[str, Any]]:
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="ignore")
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _first_text(record: dict[str, Any], *keys: str) -> Optional[str]:
    for key in keys:
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _parse_datetime(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _iter_session_files(
    codex_home: Path,
    thread_id: str,
) -> Iterable[Path]:
    seen: set[str] = set()
    sessions_root = codex_home / "sessions"
    archived_root = codex_home / "archived_sessions"
    yield from _iter_unique_matches(archived_root, f"*{thread_id}*.jsonl", seen)
    yield from _iter_unique_matches(archived_root, f"*/*/*/*{thread_id}*.jsonl", seen)
    yield from _iter_unique_matches(sessions_root, f"*/*/*/*{thread_id}*.jsonl", seen)


def _iter_unique_matches(root: Path, pattern: str, seen: set[str]) -> Iterable[Path]:
    if not root.is_dir():
        return
    try:
        matches = root.glob(pattern)
    except OSError:
        return
    for path in matches:
        try:
            key = str(path.resolve())
        except OSError:
            key = str(path)
        if key in seen:
            continue
        seen.add(key)
        if path.is_file():
            yield path


def _read_session_transcript(path: Path, thread_id: str) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    pending_agent_message: Optional[dict[str, Any]] = None
    turn_counter = 0

    try:
        with path.open("rb") as handle:
            for raw_line in handle:
                record = _parse_json_line(raw_line)
                if record is None:
                    continue

                payload = record.get("payload")
                if not isinstance(payload, dict):
                    continue

                event_type = payload.get("type")
                timestamp = _record_timestamp(record, payload)
                if event_type == "user_message":
                    turn_counter += 1
                    pending_agent_message = None
                    message = _first_text(payload, "message")
                    if message:
                        messages.append(
                            _transcript_message(
                                thread_id=thread_id,
                                turn_counter=turn_counter,
                                role="user",
                                content=message,
                                created_at=timestamp,
                                status="done",
                            )
                        )
                elif event_type == "agent_message":
                    message = _first_text(payload, "message")
                    if message:
                        pending_agent_message = _transcript_message(
                            thread_id=thread_id,
                            turn_counter=turn_counter,
                            role="assistant",
                            content=message,
                            created_at=timestamp,
                            status="streaming",
                        )
                elif event_type == "task_complete":
                    message = _first_text(payload, "last_agent_message")
                    if message:
                        messages.append(
                            _transcript_message(
                                thread_id=thread_id,
                                turn_counter=turn_counter,
                                role="assistant",
                                content=message,
                                created_at=timestamp,
                                status="done",
                            )
                        )
                    pending_agent_message = None
                elif event_type == "turn_aborted":
                    reason = _first_text(payload, "reason") or "Codex turn aborted"
                    messages.append(
                        _transcript_message(
                            thread_id=thread_id,
                            turn_counter=turn_counter,
                            role="assistant",
                            content=reason,
                            created_at=timestamp,
                            status="cancelled",
                        )
                    )
                    pending_agent_message = None
    except OSError:
        return []

    if pending_agent_message:
        messages.append(pending_agent_message)
    return messages


def _transcript_message(
    *,
    thread_id: str,
    turn_counter: int,
    role: str,
    content: str,
    created_at: str,
    status: str,
) -> dict[str, Any]:
    index = max(turn_counter, 0)
    return {
        "id": f"{thread_id}:{role}:{index}",
        "role": role,
        "content": content,
        "createdAt": created_at,
        "status": status,
    }


def _record_timestamp(record: dict[str, Any], payload: dict[str, Any]) -> str:
    return _record_timestamp_value(record, payload) or utc_now_iso()


def _record_timestamp_value(
    record: dict[str, Any],
    payload: dict[str, Any],
) -> Optional[str]:
    completed_at = payload.get("completed_at")
    if isinstance(completed_at, (int, float)):
        return datetime.fromtimestamp(completed_at, timezone.utc).isoformat()

    timestamp = record.get("timestamp") or payload.get("timestamp")
    if isinstance(timestamp, str) and timestamp.strip():
        return timestamp.strip()
    if isinstance(timestamp, (int, float)):
        return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()
    return None
