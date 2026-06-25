# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Discover Codex sessions as device-local runtime work items."""

import base64
import contextlib
import gzip
import hashlib
import json
import mimetypes
import os
import re
import sqlite3
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Optional
from urllib.parse import unquote, urlparse

from executor.agents.codex.config_builder import _resolve_codex_binary
from executor.config import config
from executor.runtime_work.local_task_store import (
    LocalTaskRecord,
    normalize_workspace_path,
    utc_now_iso,
)
from executor.services.turn_file_changes import (
    NativeTurnFileChangeTracker,
    TurnFileChangeArtifactStore,
)
from shared.logger import setup_logger

DEFAULT_CODEX_SESSION_LIMIT = 100
CODEX_SESSION_RUNNING_TAIL_LINES = 200
CODEX_TRANSCRIPT_DEFAULT_LIMIT = 50
CODEX_TRANSCRIPT_MAX_LIMIT = 200
CODEX_TRANSCRIPT_INITIAL_WINDOW_BYTES = 1024 * 1024
CODEX_TRANSCRIPT_MAX_WINDOW_BYTES = 64 * 1024 * 1024
CODEX_LOCAL_IMAGE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024
CODEX_TERMINAL_EVENT_TYPES = {"task_complete", "turn_aborted"}
CODEX_CONVERSATION_DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CODEX_TRANSCRIPT_CURSOR_PATTERN = re.compile(r"^offset:(\d+)$")

logger = setup_logger("codex_session_discovery")


@dataclass(frozen=True)
class CodexTranscriptPage:
    """A page of user-visible Codex transcript messages."""

    messages: list[dict[str, Any]]
    has_more_before: bool = False
    before_cursor: Optional[str] = None


@dataclass(frozen=True)
class _TranscriptCacheEntry:
    stat_key: tuple[int, int, int]
    messages: list[dict[str, Any]]
    complete: bool


@dataclass(frozen=True)
class _ThreadResumeConfig:
    codex_bin: str
    config_overrides: tuple[str, ...]
    env: Optional[dict[str, str]]


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
        self._transcript_cache: dict[str, _TranscriptCacheEntry] = {}
        self._thread_resume_configs: dict[str, _ThreadResumeConfig] = {}

    def discover(self) -> list[LocalTaskRecord]:
        try:
            records = self._discover_with_sdk(archived=False)
        except Exception:
            logger.exception("Failed to list Codex threads through SDK")
            return []

        return _sort_local_tasks(records)

    def discover_archived(
        self,
        *,
        workspace_path: Optional[str] = None,
        search_term: Optional[str] = None,
    ) -> list[LocalTaskRecord]:
        try:
            records = self._discover_with_sdk(
                archived=True,
                workspace_path=workspace_path,
                search_term=search_term,
            )
        except Exception:
            logger.exception("Failed to list archived Codex threads through SDK")
            return []

        return _sort_local_tasks(records)

    def _discover_with_sdk(
        self,
        *,
        archived: bool,
        workspace_path: Optional[str] = None,
        search_term: Optional[str] = None,
    ) -> list[LocalTaskRecord]:
        client = self._create_codex_client()
        with client as codex:
            response = codex.thread_list(
                limit=self.limit,
                archived=archived,
                sort_direction=_codex_enum_value("SortDirection", "desc"),
                sort_key=_codex_enum_value("ThreadSortKey", "updated_at"),
                use_state_db_only=True,
            )

        records = [
            task
            for task in (
                _thread_to_local_task(
                    thread,
                    status="archived" if archived else "active",
                )
                for thread in getattr(response, "data", [])
            )
            if task is not None
        ]
        return _filter_local_tasks(
            records,
            workspace_path=workspace_path,
            search_term=search_term,
        )

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

    def _create_async_codex_client_for_thread(
        self,
        thread_id: str,
        *,
        cwd: Optional[str],
    ) -> Any:
        resume_config = self._thread_resume_configs.get(thread_id)
        if resume_config is None:
            return self._create_async_codex_client()

        client_config = self._codex_config_type()(
            codex_bin=resume_config.codex_bin,
            config_overrides=resume_config.config_overrides,
            cwd=cwd,
            env=_codex_env(self.codex_home, resume_config.env),
        )
        return self._create_async_codex_client_with_config(client_config)

    def _remember_thread_resume_config(
        self,
        thread_id: str,
        codex_config: Any,
    ) -> None:
        clean_thread_id = thread_id.strip()
        if not clean_thread_id:
            return
        self._thread_resume_configs[clean_thread_id] = _ThreadResumeConfig(
            codex_bin=str(getattr(codex_config, "codex_bin", "") or ""),
            config_overrides=tuple(getattr(codex_config, "config_overrides", ()) or ()),
            env=dict(getattr(codex_config, "env", None) or {}),
        )

    def _codex_config_type(self) -> Any:
        from openai_codex import CodexConfig

        return CodexConfig

    def _codex_config(self, config_type: Any) -> Any:
        _ensure_codex_home(self.codex_home)
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

    def read_transcript_page(
        self,
        thread_id: str,
        session_path: Optional[str] = None,
        *,
        limit: int = CODEX_TRANSCRIPT_DEFAULT_LIMIT,
        before_cursor: Optional[str] = None,
    ) -> CodexTranscriptPage:
        started_at = time.perf_counter()
        path = self._resolve_session_path(thread_id, session_path)
        if path is None:
            logger.info(
                "[CodexTranscript] Session path not found: thread_id=%s requested_session_path=%s elapsed_ms=%s",
                thread_id,
                session_path,
                int((time.perf_counter() - started_at) * 1000),
            )
            return CodexTranscriptPage(messages=[])

        safe_limit = _normalize_transcript_limit(limit)
        before_offset = _parse_transcript_cursor(before_cursor)
        cache_key = str(path)
        stat_key = _transcript_stat_key(path)
        if stat_key is None:
            logger.info(
                "[CodexTranscript] Session stat failed: thread_id=%s path=%s elapsed_ms=%s",
                thread_id,
                path,
                int((time.perf_counter() - started_at) * 1000),
            )
            return CodexTranscriptPage(messages=[])

        cached = self._transcript_cache.get(cache_key)
        if (
            cached
            and cached.stat_key == stat_key
            and (cached.complete or before_offset is None)
        ):
            page = _paginate_transcript_messages(
                cached.messages,
                limit=safe_limit,
                before_offset=before_offset,
                complete=cached.complete,
            )
            logger.info(
                "[CodexTranscript] Page served from cache: thread_id=%s path=%s limit=%s before_cursor=%s elapsed_ms=%s message_count=%s has_more_before=%s next_cursor=%s complete=%s",
                thread_id,
                path,
                safe_limit,
                before_cursor,
                int((time.perf_counter() - started_at) * 1000),
                len(page.messages),
                page.has_more_before,
                page.before_cursor,
                cached.complete,
            )
            return page

        page = _read_session_transcript_page(
            path,
            thread_id,
            limit=safe_limit,
            before_offset=before_offset,
        )
        messages_for_cache = page.messages
        complete = not page.has_more_before
        if complete or before_offset is None:
            self._transcript_cache[cache_key] = _TranscriptCacheEntry(
                stat_key=stat_key,
                messages=messages_for_cache,
                complete=complete,
            )
        logger.info(
            "[CodexTranscript] Page read from session file: thread_id=%s path=%s limit=%s before_cursor=%s elapsed_ms=%s message_count=%s has_more_before=%s next_cursor=%s cached=%s",
            thread_id,
            path,
            safe_limit,
            before_cursor,
            int((time.perf_counter() - started_at) * 1000),
            len(page.messages),
            page.has_more_before,
            page.before_cursor,
            complete or before_offset is None,
        )
        return page

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

    def archive_thread(self, thread_id: str) -> dict[str, Any]:
        """Archive a Codex thread through the Codex SDK."""

        normalized_thread_id = _required_thread_id(thread_id)
        client = self._create_codex_client()
        with client as codex:
            codex.thread_archive(normalized_thread_id)
        return {
            "threadId": normalized_thread_id,
            "sdkUpdated": True,
        }

    def unarchive_thread(self, thread_id: str) -> None:
        client = self._create_codex_client()
        with client as codex:
            codex.thread_unarchive(thread_id)

    def rename_thread(self, thread_id: str, title: str) -> dict[str, Any]:
        """Rename a Codex thread in the local Codex state used by Codex App."""

        normalized_thread_id = _required_thread_id(thread_id)
        normalized_title = _required_title(title)
        sdk_updated = self._rename_thread_with_sdk(
            normalized_thread_id,
            normalized_title,
        )
        state_path = _find_codex_state_path(self.codex_home)
        state_result = {"updated": False, "matched": False}
        if state_path is not None:
            state_result = _rename_thread_state(
                state_path,
                normalized_thread_id,
                normalized_title,
            )
        return {
            "threadId": normalized_thread_id,
            "title": normalized_title,
            "sdkUpdated": sdk_updated,
            "stateUpdated": state_result["updated"],
            "stateMatched": state_result["matched"],
            "statePath": str(state_path) if state_path is not None else None,
        }

    def _rename_thread_with_sdk(self, thread_id: str, title: str) -> bool:
        client = self._create_codex_client()
        with client as codex:
            if _try_call_codex_rename(codex, thread_id, title):
                return True
        return False

    def delete_archived_thread(
        self,
        thread_id: str,
        *,
        session_path: Optional[str] = None,
    ) -> dict[str, Any]:
        normalized_thread_id = _required_thread_id(thread_id)
        state_path = _find_codex_state_path(self.codex_home)
        thread_state = None
        deleted_state = False

        if state_path is not None:
            thread_state, deleted_state = _delete_archived_thread_state(
                state_path,
                normalized_thread_id,
            )

        deleted_files = []
        for candidate in _unique_texts(
            session_path,
            _thread_state_text(thread_state, "rollout_path"),
        ):
            deleted_path = _delete_codex_owned_file(self.codex_home, candidate)
            if deleted_path:
                deleted_files.append(deleted_path)
                self._transcript_cache.pop(deleted_path, None)

        return {
            "threadId": normalized_thread_id,
            "deletedState": deleted_state,
            "deletedFiles": deleted_files,
            "workspacePath": _thread_state_text(thread_state, "cwd"),
            "title": _thread_state_text(thread_state, "title")
            or _thread_state_text(thread_state, "preview"),
            "createdAt": _codex_time_to_iso(_thread_state_value(thread_state, "created_at")),
            "updatedAt": _codex_time_to_iso(_thread_state_value(thread_state, "updated_at")),
        }

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

        client = self._create_async_codex_client_for_thread(thread_id, cwd=cwd)
        async with client as codex:
            thread = await codex.thread_resume(thread_id, cwd=cwd)
            turn_file_change_tracker = _attach_native_turn_file_change_tracker(
                emitter=emitter,
                workspace_path=cwd,
                task_id=getattr(emitter, "task_id", 0),
                subtask_id=getattr(emitter, "subtask_id", 0),
            )
            mapper = CodeXEventMapper(
                emitter,
                turn_file_change_tracker=turn_file_change_tracker,
            )
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

    async def open_workspace(self, workspace_path: str) -> dict[str, Any]:
        """Open a Codex thread for a workspace without starting a turn."""

        normalized_workspace_path = normalize_workspace_path(workspace_path)
        client = self._create_async_codex_client()
        async with client as codex:
            thread = await codex.thread_start(
                cwd=normalized_workspace_path,
                service_name="wegent",
                thread_source=_codex_thread_source_user(),
            )
        thread_id = _object_text(thread, "id", "session_id")
        if not thread_id:
            raise RuntimeError("Codex thread_start did not return a threadId")
        return {
            "threadId": thread_id,
            "workspacePath": normalized_workspace_path,
            "title": _object_text(thread, "name", "preview", "title")
            or Path(normalized_workspace_path).name
            or normalized_workspace_path,
        }

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
            config_overrides=_codex_lite_config_overrides(
                codex_config.config_overrides,
                use_user_config=_codex_config_uses_user_config(codex_config),
            ),
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
                    self._remember_thread_resume_config(thread_id, codex_config)

                    emitter = emitter_factory(thread_id)
                    turn_file_change_tracker = _attach_native_turn_file_change_tracker(
                        emitter=emitter,
                        workspace_path=cwd,
                        task_id=request.task_id,
                        subtask_id=request.subtask_id,
                        device_id=getattr(request, "device_id", None),
                    )
                    mapper = CodeXEventMapper(
                        emitter,
                        turn_file_change_tracker=turn_file_change_tracker,
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


def _thread_to_local_task(
    thread: Any,
    *,
    status: str = "active",
) -> Optional[LocalTaskRecord]:
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
        workspace_kind=_codex_thread_workspace_kind(cwd),
        runtime_handle=runtime_handle,
        created_at=created_at,
        updated_at=updated_at,
        running=_is_thread_running(thread)
        or _is_session_transcript_running(session_path),
        status=status,
    )


def _filter_local_tasks(
    records: list[LocalTaskRecord],
    *,
    workspace_path: Optional[str],
    search_term: Optional[str],
) -> list[LocalTaskRecord]:
    normalized_workspace = (
        normalize_workspace_path(workspace_path) if workspace_path else None
    )
    normalized_search = search_term.strip().lower() if search_term else None
    filtered = []
    for record in records:
        if normalized_workspace and record.workspace_path != normalized_workspace:
            continue
        if normalized_search and normalized_search not in " ".join(
            [
                record.title,
                record.local_task_id,
                record.workspace_path,
            ]
        ).lower():
            continue
        filtered.append(record)
    return filtered


def _required_thread_id(thread_id: str) -> str:
    if not isinstance(thread_id, str) or not thread_id.strip():
        raise ValueError("thread_id is required")
    return thread_id.strip()


def _required_title(title: str) -> str:
    if not isinstance(title, str) or not title.strip():
        raise ValueError("title is required")
    return title.strip()


def _try_call_codex_rename(codex: Any, thread_id: str, title: str) -> bool:
    for method_name in ("thread_rename", "thread_update"):
        method = getattr(codex, method_name, None)
        if method is None:
            continue
        for kwargs in ({"title": title}, {"name": title}):
            try:
                method(thread_id, **kwargs)
                return True
            except TypeError:
                continue
            except Exception:
                logger.exception("Failed to rename Codex thread through SDK")
                return False
        try:
            method(thread_id, title)
            return True
        except TypeError:
            continue
        except Exception:
            logger.exception("Failed to rename Codex thread through SDK")
            return False
    return False


def _find_codex_state_path(codex_home: Path) -> Optional[Path]:
    roots = [
        codex_home,
        codex_home / "sqlite",
        codex_home / ".codex" / "sqlite",
    ]
    candidates = [
        root / "state_5.sqlite"
        for root in roots
        if root is not None
    ]
    for root in roots:
        with contextlib.suppress(OSError):
            candidates.extend(
                sorted(
                    root.glob("state_*.sqlite"),
                    key=lambda path: path.name,
                    reverse=True,
                )
            )
    seen = set()
    for candidate in candidates:
        candidate = candidate.expanduser()
        if candidate in seen:
            continue
        seen.add(candidate)
        if candidate.is_file():
            return candidate
    return None


def _rename_thread_state(
    state_path: Path,
    thread_id: str,
    title: str,
) -> dict[str, bool]:
    try:
        connection = sqlite3.connect(str(state_path), timeout=5.0)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                row = connection.execute(
                    "SELECT * FROM threads WHERE id = ?",
                    (thread_id,),
                ).fetchone()
                if row is None:
                    return {"updated": False, "matched": False}

                columns = _sqlite_table_columns(connection, "threads")
                title_columns = [
                    column for column in ("title", "preview") if column in columns
                ]
                if not title_columns:
                    return {"updated": False, "matched": False}
                if all(
                    _sqlite_row_text(row, column) == title
                    for column in title_columns
                ):
                    return {"updated": False, "matched": True}

                assignments = []
                values: list[Any] = []
                for column in title_columns:
                    assignments.append(f"{column} = ?")
                    values.append(title)
                if "updated_at" in columns:
                    assignments.append("updated_at = ?")
                    values.append(_codex_now_for_column(row["updated_at"]))
                if "updated_at_ms" in columns:
                    assignments.append("updated_at_ms = ?")
                    values.append(int(time.time() * 1000))

                values.append(thread_id)
                cursor = connection.execute(
                    f"UPDATE threads SET {', '.join(assignments)} WHERE id = ?",
                    tuple(values),
                )
                updated = cursor.rowcount > 0
                return {"updated": updated, "matched": updated}
        finally:
            connection.close()
    except sqlite3.Error as exc:
        raise ValueError(f"Failed to rename Codex thread state: {exc}") from exc


def _sqlite_row_text(row: sqlite3.Row, column: str) -> Optional[str]:
    value = row[column]
    return value if isinstance(value, str) else None


def _codex_now_for_column(existing_value: Any) -> Any:
    if isinstance(existing_value, int):
        return int(time.time())
    if isinstance(existing_value, float):
        return time.time()
    if isinstance(existing_value, str):
        return utc_now_iso()
    return int(time.time())


def _delete_archived_thread_state(
    state_path: Path,
    thread_id: str,
) -> tuple[Optional[dict[str, Any]], bool]:
    try:
        connection = sqlite3.connect(str(state_path), timeout=5.0)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                row = connection.execute(
                    "SELECT * FROM threads WHERE id = ?",
                    (thread_id,),
                ).fetchone()
                if row is None:
                    return None, False

                thread_state = dict(row)
                archived = int(thread_state.get("archived") or 0)
                if archived != 1:
                    raise ValueError("Only archived Codex threads can be deleted")

                _delete_codex_thread_child_rows(connection, thread_id)
                cursor = connection.execute(
                    "DELETE FROM threads WHERE id = ?",
                    (thread_id,),
                )
                return thread_state, cursor.rowcount > 0
        finally:
            connection.close()
    except sqlite3.Error as exc:
        raise ValueError(f"Failed to delete Codex thread state: {exc}") from exc


def _delete_codex_thread_child_rows(
    connection: sqlite3.Connection,
    thread_id: str,
) -> None:
    if _sqlite_table_exists(connection, "thread_dynamic_tools"):
        columns = _sqlite_table_columns(connection, "thread_dynamic_tools")
        if "thread_id" in columns:
            connection.execute(
                "DELETE FROM thread_dynamic_tools WHERE thread_id = ?",
                (thread_id,),
            )

    if not _sqlite_table_exists(connection, "thread_spawn_edges"):
        return

    columns = _sqlite_table_columns(connection, "thread_spawn_edges")
    clauses = []
    values = []
    for column in ("thread_id", "parent_thread_id", "child_thread_id"):
        if column in columns:
            clauses.append(f"{column} = ?")
            values.append(thread_id)
    if clauses:
        connection.execute(
            f"DELETE FROM thread_spawn_edges WHERE {' OR '.join(clauses)}",
            tuple(values),
        )


def _sqlite_table_exists(
    connection: sqlite3.Connection,
    table_name: str,
) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def _sqlite_table_columns(
    connection: sqlite3.Connection,
    table_name: str,
) -> set[str]:
    return {
        str(row[1])
        for row in connection.execute(f"PRAGMA table_info({table_name})").fetchall()
    }


def _delete_codex_owned_file(codex_home: Path, raw_path: str) -> Optional[str]:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None

    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = codex_home / path
    resolved_path = path.resolve(strict=False)
    if not any(
        _path_is_relative_to(resolved_path, root)
        for root in _codex_owned_roots(codex_home)
    ):
        logger.warning("Skipping Codex file delete outside Codex home: %s", path)
        return None

    if not path.is_file():
        return None
    path.unlink()
    return str(resolved_path)


def _codex_owned_roots(codex_home: Path) -> list[Path]:
    roots = [codex_home, codex_home / ".codex"]
    if codex_home.name == ".codex":
        roots.append(codex_home.parent / ".codex")
    return [root.expanduser().resolve(strict=False) for root in roots]


def _path_is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _unique_texts(*values: Optional[str]) -> list[str]:
    seen = set()
    result = []
    for value in values:
        if not isinstance(value, str) or not value.strip():
            continue
        normalized = value.strip()
        if normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def _thread_state_text(
    thread_state: Optional[dict[str, Any]],
    key: str,
) -> Optional[str]:
    value = _thread_state_value(thread_state, key)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _thread_state_value(
    thread_state: Optional[dict[str, Any]],
    key: str,
) -> Any:
    if not isinstance(thread_state, dict):
        return None
    return thread_state.get(key)


def _codex_thread_workspace_kind(cwd: str) -> str:
    return "chat" if _is_codex_app_conversation_path(cwd) else "workspace"


def _is_codex_app_conversation_path(cwd: str) -> bool:
    try:
        path = Path(cwd).expanduser().resolve(strict=False)
        root = (Path.home() / "Documents" / "Codex").resolve(strict=False)
        relative = path.relative_to(root)
    except ValueError:
        return False

    parts = relative.parts
    return len(parts) >= 2 and bool(CODEX_CONVERSATION_DATE_PATTERN.fullmatch(parts[0]))


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
        status_type = _object_text(status, "type", "status", "value", "name")
        if not status_type:
            status_type = _object_text(
                _object_value(status, "root"),
                "type",
                "status",
                "value",
                "name",
            )

    normalized = (status_type or "").replace("_", "").lower()
    return normalized not in ("", "notloaded", "completed", "archived", "idle")


def _is_session_transcript_running(session_path: Optional[str]) -> bool:
    if not session_path:
        return False

    path = Path(session_path).expanduser()
    if not path.is_file():
        return False

    try:
        lines: deque[str] = deque(maxlen=CODEX_SESSION_RUNNING_TAIL_LINES)
        with path.open(encoding="utf-8", errors="replace") as handle:
            for line in handle:
                lines.append(line)
    except OSError:
        return False

    active_turn = False
    pending_call_ids: set[str] = set()
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            continue

        payload_type = payload.get("type")
        if entry.get("type") == "event_msg" and payload_type == "task_started":
            active_turn = True
            pending_call_ids.clear()
            continue
        if (
            entry.get("type") == "event_msg"
            and payload_type in CODEX_TERMINAL_EVENT_TYPES
        ):
            active_turn = False
            pending_call_ids.clear()
            continue

        if entry.get("type") != "response_item":
            continue
        if payload_type == "function_call":
            call_id = _payload_text(payload, "call_id", "id")
            if call_id:
                pending_call_ids.add(call_id)
        elif payload_type == "function_call_output":
            call_id = _payload_text(payload, "call_id")
            if call_id:
                pending_call_ids.discard(call_id)

    return active_turn or bool(pending_call_ids)


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


def _payload_text(payload: dict[str, Any], *names: str) -> Optional[str]:
    for name in names:
        value = payload.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
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
    _ensure_codex_home(codex_home)
    env = {**os.environ, "CODEX_HOME": str(codex_home)}
    if runtime_env:
        env.update(runtime_env)
    return env


def _ensure_codex_home(codex_home: Path) -> None:
    codex_home.mkdir(parents=True, exist_ok=True)


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
        "thread_source": _codex_thread_source_user(),
    }
    if cwd:
        kwargs["cwd"] = cwd
    if not _codex_config_uses_user_config(codex_config) and codex_config.model_provider:
        kwargs["model_provider"] = codex_config.model_provider
    return kwargs


def _codex_config_uses_user_config(codex_config: Any) -> bool:
    return bool(getattr(codex_config, "use_user_config", False))


def _codex_lite_config_overrides(
    overrides: Iterable[str],
    *,
    use_user_config: bool,
) -> tuple[str, ...]:
    if not use_user_config:
        return tuple(override for override in overrides if isinstance(override, str))
    return tuple(
        override
        for override in overrides
        if isinstance(override, str) and not _is_model_provider_override(override)
    )


def _is_model_provider_override(override: str) -> bool:
    normalized = override.strip()
    return normalized.startswith(
        (
            "forced_login_method=",
            "model_provider=",
            "model_providers.",
        )
    )


def _codex_thread_source_user() -> Any:
    try:
        from openai_codex.generated.v2_all import ThreadSource

        return ThreadSource.user
    except (ImportError, AttributeError):
        return "user"


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


def _codex_user_message_content(payload: dict[str, Any]) -> Optional[str]:
    message = _first_text(payload, "message") or ""
    local_image_paths = _local_image_paths_from_payload(payload)
    if not local_image_paths:
        return message or None
    return _build_files_mentioned_text(message, local_image_paths).lstrip()


def _local_image_paths_from_payload(payload: dict[str, Any]) -> list[str]:
    paths: list[str] = []
    seen: set[str] = set()
    for key in ("local_images", "localImages", "images"):
        value = payload.get(key)
        if not isinstance(value, list):
            continue
        for item in value:
            path = _local_image_path_from_item(item)
            if path is None or path in seen:
                continue
            seen.add(path)
            paths.append(path)
    return paths


def _local_image_path_from_item(item: Any) -> Optional[str]:
    if isinstance(item, str):
        return _normalize_local_image_path(item)
    if not isinstance(item, dict):
        return None

    for key in ("path", "local_path", "localPath", "file_path", "filePath"):
        path = _normalize_local_image_path(item.get(key))
        if path is not None:
            return path
    return None


def _normalize_local_image_path(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    path = value.strip()
    if not path:
        return None
    parsed = urlparse(path)
    if parsed.scheme and parsed.scheme != "file":
        return None
    return path


def _set_local_image_attachments(
    message: dict[str, Any],
    payload: dict[str, Any],
    created_at: str,
) -> None:
    attachments = [
        attachment
        for path in _local_image_paths_from_payload(payload)
        if (attachment := _local_image_attachment(path, created_at)) is not None
    ]
    if attachments:
        message["attachments"] = attachments


def _local_image_attachment(path: str, created_at: str) -> Optional[dict[str, Any]]:
    filesystem_path = _local_image_filesystem_path(path)
    file_path = Path(filesystem_path)
    try:
        stat = file_path.stat()
    except OSError:
        return None
    if not file_path.is_file() or stat.st_size > CODEX_LOCAL_IMAGE_PREVIEW_MAX_BYTES:
        return None

    mime_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    if not mime_type.startswith("image/"):
        return None

    try:
        encoded = base64.b64encode(file_path.read_bytes()).decode("ascii")
    except OSError:
        return None

    return {
        "id": _local_image_attachment_id(path),
        "filename": file_path.name,
        "file_size": stat.st_size,
        "mime_type": mime_type,
        "status": "ready",
        "file_extension": file_path.suffix,
        "created_at": created_at,
        "local_preview_url": f"data:{mime_type};base64,{encoded}",
    }


def _local_image_filesystem_path(path: str) -> str:
    if not path.startswith("file://"):
        return path
    parsed = urlparse(path)
    pathname = unquote(parsed.path)
    return pathname[1:] if re.match(r"^/[a-zA-Z]:/", pathname) else pathname


def _local_image_attachment_id(path: str) -> int:
    digest = hashlib.sha256(path.encode("utf-8")).hexdigest()
    return int(digest[:12], 16)


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
    processing_blocks: list[dict[str, Any]] = []
    tool_blocks_by_call_id: dict[str, dict[str, Any]] = {}
    turn_started_at: Optional[str] = None
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

                event_type = payload.get("type") or record.get("type")
                timestamp = _record_timestamp(record, payload)
                if record.get("type") == "response_item":
                    if turn_counter > 0:
                        _append_response_item_block(
                            payload=payload,
                            timestamp=timestamp,
                            thread_id=thread_id,
                            turn_counter=turn_counter,
                            processing_blocks=processing_blocks,
                            tool_blocks_by_call_id=tool_blocks_by_call_id,
                        )
                    continue

                if event_type == "user_message":
                    if pending_agent_message:
                        pending_agent_message["status"] = "done"
                        _set_message_blocks(pending_agent_message, processing_blocks)
                        messages.append(pending_agent_message)
                    turn_counter += 1
                    pending_agent_message = None
                    processing_blocks = []
                    tool_blocks_by_call_id = {}
                    turn_started_at = timestamp
                    message = _codex_user_message_content(payload)
                    if message:
                        user_message = _transcript_message(
                            thread_id=thread_id,
                            turn_counter=turn_counter,
                            role="user",
                            content=message,
                            created_at=timestamp,
                            status="done",
                        )
                        _set_local_image_attachments(user_message, payload, timestamp)
                        messages.append(user_message)
                elif event_type == "agent_message":
                    message = _first_text(payload, "message")
                    if message:
                        pending_agent_message = _transcript_message(
                            thread_id=thread_id,
                            turn_counter=turn_counter,
                            role="assistant",
                            content=message,
                            created_at=turn_started_at or timestamp,
                            status="streaming",
                            blocks=processing_blocks,
                        )
                elif event_type == "task_complete":
                    message = _first_text(payload, "last_agent_message")
                    _finish_processing_blocks(processing_blocks, timestamp)
                    if message:
                        messages.append(
                            _transcript_message(
                                thread_id=thread_id,
                                turn_counter=turn_counter,
                                role="assistant",
                                content=message,
                                created_at=turn_started_at or timestamp,
                                status="done",
                                blocks=processing_blocks,
                            )
                        )
                    elif pending_agent_message:
                        pending_agent_message["status"] = "done"
                        _set_message_blocks(pending_agent_message, processing_blocks)
                        messages.append(pending_agent_message)
                    pending_agent_message = None
                    processing_blocks = []
                    tool_blocks_by_call_id = {}
                    turn_started_at = None
                elif event_type == "turn_aborted":
                    reason = _first_text(payload, "reason") or "Codex turn aborted"
                    _finish_processing_blocks(processing_blocks, timestamp)
                    messages.append(
                        _transcript_message(
                            thread_id=thread_id,
                            turn_counter=turn_counter,
                            role="assistant",
                            content=reason,
                            created_at=turn_started_at or timestamp,
                            status="cancelled",
                            blocks=processing_blocks,
                        )
                    )
                    pending_agent_message = None
                    processing_blocks = []
                    tool_blocks_by_call_id = {}
                    turn_started_at = None
    except OSError:
        return []

    if pending_agent_message:
        _set_message_blocks(pending_agent_message, processing_blocks)
        messages.append(pending_agent_message)
    return messages


def _read_session_transcript_page(
    path: Path,
    thread_id: str,
    *,
    limit: int,
    before_offset: Optional[int],
) -> CodexTranscriptPage:
    started_at = time.perf_counter()
    try:
        file_size = path.stat().st_size
    except OSError:
        return CodexTranscriptPage(messages=[])

    if file_size <= 0:
        return CodexTranscriptPage(messages=[])

    window_size = min(CODEX_TRANSCRIPT_INITIAL_WINDOW_BYTES, file_size)
    max_window_size = min(CODEX_TRANSCRIPT_MAX_WINDOW_BYTES, file_size)

    while True:
        segment_end = min(before_offset or file_size, file_size)
        window_start = max(0, segment_end - window_size)
        window_started_at = time.perf_counter()
        messages = _read_session_transcript_window(
            path,
            thread_id,
            window_start,
            segment_end,
        )
        window_elapsed_ms = int((time.perf_counter() - window_started_at) * 1000)
        complete = window_start == 0
        page = _paginate_transcript_messages(
            messages,
            limit=limit,
            before_offset=before_offset,
            complete=complete,
        )
        logger.info(
            "[CodexTranscript] Window parsed: thread_id=%s path=%s file_size=%s window_start=%s segment_end=%s window_bytes=%s window_elapsed_ms=%s total_elapsed_ms=%s parsed_messages=%s page_messages=%s file_change_messages=%s complete=%s has_more_before=%s",
            thread_id,
            path,
            file_size,
            window_start,
            segment_end,
            segment_end - window_start,
            window_elapsed_ms,
            int((time.perf_counter() - started_at) * 1000),
            len(messages),
            len(page.messages),
            sum(1 for message in page.messages if message.get("fileChanges")),
            complete,
            page.has_more_before,
        )

        if len(page.messages) >= limit or complete:
            return page

        if window_size >= max_window_size:
            return page

        window_size = min(window_size * 2, max_window_size)


def _read_session_transcript_window(
    path: Path,
    thread_id: str,
    window_start: int,
    segment_end: int,
) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    pending_agent_message: Optional[dict[str, Any]] = None
    processing_blocks: list[dict[str, Any]] = []
    tool_blocks_by_call_id: dict[str, dict[str, Any]] = {}
    turn_started_at: Optional[str] = None
    turn_workspace_path: Optional[str] = None
    turn_patch_diffs: list[dict[str, Any]] = []
    turn_counter = 0

    try:
        with path.open("rb") as handle:
            if window_start > 0:
                handle.seek(window_start)
                handle.readline()
            for raw_line in handle:
                line_start = handle.tell() - len(raw_line)
                if line_start >= segment_end:
                    break
                record = _parse_json_line(raw_line)
                if record is None:
                    continue

                payload = record.get("payload")
                if not isinstance(payload, dict):
                    continue

                event_type = payload.get("type") or record.get("type")
                timestamp = _record_timestamp(record, payload)
                if event_type == "turn_context":
                    cwd = payload.get("cwd")
                    if isinstance(cwd, str) and cwd.strip():
                        turn_workspace_path = cwd.strip()
                    continue
                if event_type == "patch_apply_end":
                    turn_patch_diffs.extend(_patch_diffs_from_payload(payload))
                    continue
                if record.get("type") == "response_item":
                    if turn_counter > 0:
                        _append_response_item_block(
                            payload=payload,
                            timestamp=timestamp,
                            thread_id=thread_id,
                            turn_counter=turn_counter,
                            processing_blocks=processing_blocks,
                            tool_blocks_by_call_id=tool_blocks_by_call_id,
                        )
                    continue

                if event_type == "user_message":
                    if pending_agent_message:
                        pending_agent_message["status"] = "done"
                        _set_message_blocks(pending_agent_message, processing_blocks)
                        file_changes = _codex_turn_file_changes(
                            thread_id=thread_id,
                            turn_index=turn_counter,
                            workspace_path=turn_workspace_path,
                            patch_diffs=turn_patch_diffs,
                        )
                        if file_changes:
                            pending_agent_message["subtaskId"] = _codex_turn_subtask_id(
                                thread_id, turn_counter
                            )
                            pending_agent_message["fileChanges"] = file_changes
                        messages.append(pending_agent_message)
                    global_turn = _payload_turn_index(payload)
                    if global_turn is None:
                        turn_counter += 1
                        global_turn = turn_counter
                    else:
                        turn_counter = global_turn
                    pending_agent_message = None
                    processing_blocks = []
                    tool_blocks_by_call_id = {}
                    turn_started_at = timestamp
                    turn_patch_diffs = []
                    cwd = payload.get("cwd")
                    if isinstance(cwd, str) and cwd.strip():
                        turn_workspace_path = cwd.strip()
                    message = _codex_user_message_content(payload)
                    if message:
                        user_message = _transcript_message_from_offset(
                            thread_id=thread_id,
                            offset=line_start,
                            role="user",
                            content=message,
                            created_at=timestamp,
                            status="done",
                        )
                        _set_local_image_attachments(user_message, payload, timestamp)
                        messages.append(user_message)
                elif event_type == "agent_message":
                    message = _first_text(payload, "message")
                    if message:
                        pending_agent_message = _transcript_message_from_offset(
                            thread_id=thread_id,
                            offset=line_start,
                            role="assistant",
                            content=message,
                            created_at=turn_started_at or timestamp,
                            status="streaming",
                            blocks=processing_blocks,
                        )
                elif event_type == "task_complete":
                    message = _first_text(payload, "last_agent_message")
                    _finish_processing_blocks(processing_blocks, timestamp)
                    if message:
                        file_changes = _codex_turn_file_changes(
                            thread_id=thread_id,
                            turn_index=turn_counter,
                            workspace_path=turn_workspace_path,
                            patch_diffs=turn_patch_diffs,
                        )
                        messages.append(
                            _transcript_message_from_offset(
                                thread_id=thread_id,
                                offset=line_start,
                                role="assistant",
                                content=message,
                                created_at=turn_started_at or timestamp,
                                status="done",
                                blocks=processing_blocks,
                                subtask_id=(
                                    _codex_turn_subtask_id(thread_id, turn_counter)
                                    if file_changes
                                    else None
                                ),
                                file_changes=file_changes,
                            )
                        )
                    elif pending_agent_message:
                        pending_agent_message["status"] = "done"
                        _set_message_blocks(pending_agent_message, processing_blocks)
                        file_changes = _codex_turn_file_changes(
                            thread_id=thread_id,
                            turn_index=turn_counter,
                            workspace_path=turn_workspace_path,
                            patch_diffs=turn_patch_diffs,
                        )
                        if file_changes:
                            pending_agent_message["subtaskId"] = _codex_turn_subtask_id(
                                thread_id, turn_counter
                            )
                            pending_agent_message["fileChanges"] = file_changes
                        messages.append(pending_agent_message)
                    pending_agent_message = None
                    processing_blocks = []
                    tool_blocks_by_call_id = {}
                    turn_started_at = None
                    turn_patch_diffs = []
                elif event_type == "turn_aborted":
                    reason = _first_text(payload, "reason") or "Codex turn aborted"
                    _finish_processing_blocks(processing_blocks, timestamp)
                    file_changes = _codex_turn_file_changes(
                        thread_id=thread_id,
                        turn_index=turn_counter,
                        workspace_path=turn_workspace_path,
                        patch_diffs=turn_patch_diffs,
                    )
                    messages.append(
                        _transcript_message_from_offset(
                            thread_id=thread_id,
                            offset=line_start,
                            role="assistant",
                            content=reason,
                            created_at=turn_started_at or timestamp,
                            status="cancelled",
                            blocks=processing_blocks,
                            subtask_id=(
                                _codex_turn_subtask_id(thread_id, turn_counter)
                                if file_changes
                                else None
                            ),
                            file_changes=file_changes,
                        )
                    )
                    pending_agent_message = None
                    processing_blocks = []
                    tool_blocks_by_call_id = {}
                    turn_started_at = None
                    turn_patch_diffs = []
    except OSError:
        return []

    if pending_agent_message:
        _set_message_blocks(pending_agent_message, processing_blocks)
        file_changes = _codex_turn_file_changes(
            thread_id=thread_id,
            turn_index=turn_counter,
            workspace_path=turn_workspace_path,
            patch_diffs=turn_patch_diffs,
        )
        if file_changes:
            pending_agent_message["subtaskId"] = _codex_turn_subtask_id(
                thread_id, turn_counter
            )
            pending_agent_message["fileChanges"] = file_changes
        messages.append(pending_agent_message)
    return messages


def _paginate_transcript_messages(
    messages: list[dict[str, Any]],
    *,
    limit: int,
    before_offset: Optional[int],
    complete: bool,
) -> CodexTranscriptPage:
    eligible = [
        message
        for message in messages
        if before_offset is None or _message_cursor_offset(message) < before_offset
    ]
    page_messages = eligible[-limit:]
    first_offset = _first_message_offset(page_messages)
    has_more_before = False
    if first_offset is not None:
        has_more_before = (
            any(_message_cursor_offset(message) < first_offset for message in eligible)
            or not complete
        )

    before_cursor = (
        f"offset:{first_offset}" if has_more_before and first_offset else None
    )
    return CodexTranscriptPage(
        messages=page_messages,
        has_more_before=has_more_before,
        before_cursor=before_cursor,
    )


def _normalize_transcript_limit(value: Any) -> int:
    if isinstance(value, bool):
        return CODEX_TRANSCRIPT_DEFAULT_LIMIT
    if isinstance(value, int):
        return min(max(1, value), CODEX_TRANSCRIPT_MAX_LIMIT)
    return CODEX_TRANSCRIPT_DEFAULT_LIMIT


def _parse_transcript_cursor(value: Optional[str]) -> Optional[int]:
    if not isinstance(value, str):
        return None
    match = CODEX_TRANSCRIPT_CURSOR_PATTERN.match(value.strip())
    if not match:
        return None
    return int(match.group(1))


def _transcript_stat_key(path: Path) -> Optional[tuple[int, int, int]]:
    try:
        stat = path.stat()
    except OSError:
        return None
    return (int(stat.st_ino), int(stat.st_mtime_ns), int(stat.st_size))


def _payload_turn_index(payload: dict[str, Any]) -> Optional[int]:
    for key in ("turn_counter", "turnCounter", "turn_index", "turnIndex"):
        value = payload.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int) and value > 0:
            return value
    return None


def _message_cursor_offset(message: dict[str, Any]) -> int:
    value = message.get("_cursorOffset")
    if isinstance(value, bool):
        return 0
    if isinstance(value, int) and value >= 0:
        return value
    return 0


def _first_message_offset(messages: list[dict[str, Any]]) -> Optional[int]:
    for message in messages:
        offset = _message_cursor_offset(message)
        if offset > 0:
            return offset
    return None


def _append_response_item_block(
    *,
    payload: dict[str, Any],
    timestamp: str,
    thread_id: str,
    turn_counter: int,
    processing_blocks: list[dict[str, Any]],
    tool_blocks_by_call_id: dict[str, dict[str, Any]],
) -> None:
    item_type = _normalize_codex_type(payload.get("type"))
    timestamp_ms = _timestamp_to_millis(timestamp)

    if item_type == "reasoning":
        content = _extract_reasoning_text(payload)
        if not content:
            return
        block_id = _first_text(payload, "id") or (
            f"{thread_id}:thinking:{turn_counter}:{len(processing_blocks)}"
        )
        processing_blocks.append(
            {
                "id": block_id,
                "type": "thinking",
                "content": content,
                "status": "done",
                "timestamp": timestamp_ms,
            }
        )
        return

    if item_type == "function_call":
        call_id = _response_item_call_id(payload)
        if not call_id:
            return
        raw_name = _first_text(payload, "name") or "unknown"
        raw_arguments = _parse_tool_arguments(payload.get("arguments"))
        tool_name, tool_input = _normalize_tool(raw_name, raw_arguments)
        block = {
            "id": call_id,
            "type": "tool",
            "tool_use_id": call_id,
            "tool_name": tool_name,
            "tool_input": tool_input,
            "status": "pending",
            "timestamp": timestamp_ms,
        }
        processing_blocks.append(block)
        tool_blocks_by_call_id[call_id] = block
        return

    if item_type == "function_call_output":
        call_id = _response_item_call_id(payload)
        if not call_id:
            return
        block = tool_blocks_by_call_id.get(call_id)
        if block is None:
            block = {
                "id": call_id,
                "type": "tool",
                "tool_use_id": call_id,
                "tool_name": "unknown",
                "tool_input": {},
                "timestamp": timestamp_ms,
            }
            processing_blocks.append(block)
            tool_blocks_by_call_id[call_id] = block
        block["tool_output"] = _stringify_tool_output(payload.get("output"))
        block["status"] = "done"
        _set_block_timestamp(block, timestamp_ms)
        return

    if item_type == "message":
        phase = _normalize_codex_type(payload.get("phase"))
        role = str(payload.get("role") or "").lower()
        if phase != "commentary" or role != "assistant":
            return
        content = _extract_response_message_text(payload)
        if not content:
            return
        block_id = _first_text(payload, "id") or (
            f"{thread_id}:text:{turn_counter}:{len(processing_blocks)}"
        )
        processing_blocks.append(
            {
                "id": block_id,
                "type": "text",
                "content": content,
                "status": "done",
                "timestamp": timestamp_ms,
            }
        )


def _set_message_blocks(
    message: dict[str, Any],
    blocks: list[dict[str, Any]],
) -> None:
    if blocks:
        message["blocks"] = list(blocks)


def _finish_processing_blocks(blocks: list[dict[str, Any]], timestamp: str) -> None:
    if not blocks:
        return
    _set_block_timestamp(blocks[-1], _timestamp_to_millis(timestamp))


def _set_block_timestamp(block: dict[str, Any], timestamp_ms: int) -> None:
    current = block.get("timestamp")
    if isinstance(current, (int, float)) and current >= timestamp_ms:
        return
    block["timestamp"] = timestamp_ms


def _transcript_message(
    *,
    thread_id: str,
    turn_counter: int,
    role: str,
    content: str,
    created_at: str,
    status: str,
    blocks: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    index = max(turn_counter, 0)
    message = {
        "id": f"{thread_id}:{role}:{index}",
        "role": role,
        "content": content,
        "createdAt": created_at,
        "status": status,
    }
    _set_message_blocks(message, blocks or [])
    return message


def _transcript_message_from_offset(
    *,
    thread_id: str,
    offset: int,
    role: str,
    content: str,
    created_at: str,
    status: str,
    blocks: Optional[list[dict[str, Any]]] = None,
    subtask_id: Optional[int] = None,
    file_changes: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    message = {
        "id": f"{thread_id}:{role}:o{max(offset, 0)}",
        "role": role,
        "content": content,
        "createdAt": created_at,
        "status": status,
        "_cursorOffset": max(offset, 0),
    }
    if subtask_id is not None:
        message["subtaskId"] = subtask_id
    if file_changes:
        message["fileChanges"] = file_changes
    _set_message_blocks(message, blocks or [])
    return message


def _patch_diffs_from_payload(payload: dict[str, Any]) -> list[dict[str, Any]]:
    if payload.get("success") is not True:
        return []
    changes = payload.get("changes")
    if not isinstance(changes, dict):
        return []
    diffs: list[dict[str, Any]] = []
    for path, change in changes.items():
        if not isinstance(change, dict):
            continue
        change_type = _codex_patch_change_type(change.get("type"))
        diff = change.get("unified_diff")
        if not isinstance(diff, str) or not diff.strip():
            diff = _codex_patch_diff_from_content(change)
        if isinstance(diff, str) and diff.strip():
            diffs.append(
                {
                    "path": str(path),
                    "change_type": change_type,
                    "diff": diff,
                }
            )
    return diffs


def _codex_turn_subtask_id(thread_id: str, turn_index: int) -> int:
    digest = hashlib.sha256(f"{thread_id}:{turn_index}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % 8_000_000_000_000 + 1


def _codex_turn_file_changes(
    *,
    thread_id: str,
    turn_index: int,
    workspace_path: Optional[str],
    patch_diffs: list[dict[str, Any]],
) -> Optional[dict[str, Any]]:
    if not workspace_path or not patch_diffs:
        return None
    files: list[dict[str, Any]] = []
    files_by_path: dict[str, dict[str, Any]] = {}
    rendered_diffs: list[str] = []
    for item in patch_diffs:
        path = item.get("path")
        diff = item.get("diff")
        change_type = item.get("change_type")
        if not isinstance(path, str) or not path or not isinstance(diff, str):
            continue
        display_path = _codex_display_path(path, workspace_path)
        additions, deletions = _codex_patch_line_stats(diff)
        existing = files_by_path.get(display_path)
        if existing is None:
            existing = {
                "old_path": None,
                "path": display_path,
                "change_type": (
                    change_type if isinstance(change_type, str) else "modified"
                ),
                "additions": 0,
                "deletions": 0,
                "binary": False,
            }
            files_by_path[display_path] = existing
        existing["additions"] += additions
        existing["deletions"] += deletions
        existing["change_type"] = _merge_codex_change_type(
            str(existing["change_type"]),
            change_type if isinstance(change_type, str) else "modified",
        )
        rendered_diffs.append(_render_codex_patch_diff(display_path, diff, change_type))
    if not files_by_path:
        return None
    artifact_id = _persist_codex_patch_sequence(
        workspace_path=workspace_path,
        task_id=_codex_turn_subtask_id(thread_id, 0),
        subtask_id=_codex_turn_subtask_id(thread_id, turn_index),
        patch_sequence=rendered_diffs,
    )
    files = list(files_by_path.values())
    files = sorted(files, key=lambda item: item["path"])
    rendered_diff = "\n".join(rendered_diffs)
    return {
        "version": 1,
        "status": "active",
        "artifact_id": artifact_id,
        "device_id": "runtime-device",
        "workspace_path": str(Path(workspace_path).expanduser()),
        "file_count": len(files),
        "additions": sum(item["additions"] for item in files),
        "deletions": sum(item["deletions"] for item in files),
        "files": files,
        "reverted_at": None,
        "diff": rendered_diff,
        "revertible": True,
    }


def _codex_patch_change_type(value: Any) -> str:
    if value == "add":
        return "created"
    if value == "delete":
        return "deleted"
    return "modified"


def _codex_patch_diff_from_content(change: dict[str, Any]) -> Optional[str]:
    content = change.get("content")
    if not isinstance(content, str):
        return None

    change_type = _codex_patch_change_type(change.get("type"))
    if change_type == "created":
        prefix = "+"
        old_start = "0,0"
        new_start = f"1,{_codex_patch_content_line_count(content)}"
    elif change_type == "deleted":
        prefix = "-"
        old_start = f"1,{_codex_patch_content_line_count(content)}"
        new_start = "0,0"
    else:
        return None

    lines = [f"@@ -{old_start} +{new_start} @@"]
    lines.extend(f"{prefix}{line}" for line in content.splitlines())
    if content.endswith("\n"):
        lines.append("")
    return "\n".join(lines)


def _codex_patch_content_line_count(content: str) -> int:
    if not content:
        return 0
    return len(content.splitlines())


def _persist_codex_patch_sequence(
    *,
    workspace_path: str,
    task_id: int,
    subtask_id: int,
    patch_sequence: list[str],
) -> str:
    artifact_id = f"turn-file-changes/{task_id}/{subtask_id}"
    artifact_dir = (
        Path(config.WEGENT_EXECUTOR_HOME).expanduser() / "artifacts" / artifact_id
    )
    artifact_dir.mkdir(parents=True, exist_ok=True)
    patch_path = artifact_dir / "changes.patch.gz"
    metadata_path = artifact_dir / "metadata.json"
    payload = json.dumps(patch_sequence, ensure_ascii=True).encode("utf-8")
    metadata = {
        "version": 1,
        "task_id": task_id,
        "subtask_id": subtask_id,
        "workspace_path": str(Path(workspace_path).expanduser()),
        "checksum": hashlib.sha256(payload).hexdigest(),
        "patch_sequence": True,
    }
    TurnFileChangeArtifactStore.atomic_write(patch_path, gzip.compress(payload))
    TurnFileChangeArtifactStore.atomic_write(
        metadata_path,
        json.dumps(metadata, ensure_ascii=True, sort_keys=True).encode("utf-8"),
    )
    return artifact_id


def _merge_codex_change_type(current: str, incoming: str) -> str:
    if current == incoming:
        return current
    if "deleted" in {current, incoming}:
        return "deleted" if incoming == "deleted" else "modified"
    if "created" in {current, incoming}:
        return "created" if current == "created" else "modified"
    return "modified"


def _codex_patch_line_stats(diff: str) -> tuple[int, int]:
    additions = 0
    deletions = 0
    for line in diff.splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            additions += 1
        elif line.startswith("-") and not line.startswith("---"):
            deletions += 1
    return additions, deletions


def _render_codex_patch_diff(path: str, diff: str, change_type: Optional[str]) -> str:
    normalized = path.replace("\\", "/")
    if change_type == "created":
        header = [
            f"diff --git a/{normalized} b/{normalized}",
            "new file mode 100644",
            "--- /dev/null",
            f"+++ b/{normalized}",
        ]
    elif change_type == "deleted":
        header = [
            f"diff --git a/{normalized} b/{normalized}",
            "deleted file mode 100644",
            f"--- a/{normalized}",
            "+++ /dev/null",
        ]
    else:
        header = [
            f"diff --git a/{normalized} b/{normalized}",
            f"--- a/{normalized}",
            f"+++ b/{normalized}",
        ]
    return "\n".join([*header, diff.rstrip()]) + "\n"


def _codex_display_path(path: str, workspace_path: str) -> str:
    workspace = Path(workspace_path).expanduser()
    candidate = Path(path).expanduser()
    with contextlib.suppress(ValueError):
        return candidate.relative_to(workspace).as_posix()
    return path


def _attach_native_turn_file_change_tracker(
    *,
    emitter: Any,
    workspace_path: Optional[str],
    task_id: Any,
    subtask_id: Any,
    device_id: Any = None,
) -> Optional[NativeTurnFileChangeTracker]:
    if not workspace_path:
        return None
    tracker = NativeTurnFileChangeTracker(
        workspace=Path(workspace_path),
        task_id=_safe_positive_int(task_id),
        subtask_id=_safe_positive_int(subtask_id),
        executor_home=Path(config.WEGENT_EXECUTOR_HOME),
        device_id=device_id if isinstance(device_id, str) and device_id else None,
    )
    set_completion_fields_provider = getattr(
        emitter,
        "set_completion_fields_provider",
        None,
    )
    if callable(set_completion_fields_provider):
        set_completion_fields_provider(tracker.finalize)
    return tracker


def _safe_positive_int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int) and value > 0:
        return value
    return 0


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


def _timestamp_to_millis(value: str) -> int:
    parsed = _parse_datetime(value)
    if parsed is not None:
        return int(parsed.timestamp() * 1000)
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _normalize_codex_type(value: Any) -> str:
    raw_value = getattr(value, "value", value)
    return str(raw_value or "").replace("-", "_").lower()


def _response_item_call_id(payload: dict[str, Any]) -> Optional[str]:
    return _first_text(payload, "call_id", "callId", "id")


def _parse_tool_arguments(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {"arguments": value}
        return parsed if isinstance(parsed, dict) else {"arguments": parsed}
    return {}


def _normalize_tool(
    name: str,
    arguments: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    if name != "exec_command":
        return name, arguments

    normalized_arguments = dict(arguments)
    command = normalized_arguments.pop("cmd", None)
    workdir = normalized_arguments.pop("workdir", None)
    if command is not None:
        normalized_arguments["command"] = command
    if workdir is not None:
        normalized_arguments["cwd"] = workdir
    return "bash", normalized_arguments


def _extract_reasoning_text(payload: dict[str, Any]) -> Optional[str]:
    parts = _collect_text_parts(payload.get("summary"))
    if not parts:
        parts = _collect_text_parts(payload.get("content"))
    content = "\n".join(parts).strip()
    return content or None


def _extract_response_message_text(payload: dict[str, Any]) -> Optional[str]:
    text = _first_text(payload, "text")
    if text:
        return text
    content = "\n".join(_collect_text_parts(payload.get("content"))).strip()
    return content or None


def _collect_text_parts(value: Any) -> list[str]:
    if isinstance(value, str):
        text = value.strip()
        return [text] if text else []
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            parts.extend(_collect_text_parts(item))
        return parts
    if isinstance(value, dict):
        parts: list[str] = []
        for key in ("text", "content"):
            parts.extend(_collect_text_parts(value.get(key)))
        return parts
    return []


def _stringify_tool_output(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(value)
