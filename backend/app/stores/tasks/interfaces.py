# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Literal, Optional, Protocol, Sequence

from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource


@dataclass(frozen=True)
class WorkspaceRefLookup:
    """Lookup key for loading a workspace resource."""

    user_id: int
    namespace: str
    name: str


class TaskIdAllocationError(RuntimeError):
    """Raised when a task ID reservation cannot be allocated."""


class TaskStore(Protocol):
    """Data access boundary for Task and Workspace resources."""

    def create_placeholder_task_id(self, db: Session, *, user_id: int) -> int: ...

    def is_valid_task_id(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> bool: ...

    def create_pending_task_shell(
        self,
        db: Session,
        *,
        user_id: int,
        client_origin: str,
        is_group_chat: bool = False,
        project_id: int = 0,
    ) -> TaskResource: ...

    def create_workspace(
        self,
        db: Session,
        *,
        user_id: int,
        name: str,
        namespace: str,
        payload: dict[str, Any],
        client_origin: str,
    ) -> TaskResource: ...

    def create_pending_task_shell_with_workspace(
        self,
        db: Session,
        *,
        user_id: int,
        client_origin: str,
        workspace_factory: Callable[[int], tuple[str, str, dict[str, Any]]],
        is_group_chat: bool = False,
        project_id: int = 0,
    ) -> tuple[TaskResource, TaskResource]: ...

    def create_task(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        name: str,
        namespace: str,
        payload: dict[str, Any],
        client_origin: str,
        project_id: int = 0,
        is_group_chat: bool = False,
    ) -> TaskResource: ...

    def create_task_resource(
        self,
        db: Session,
        *,
        user_id: int,
        name: str,
        namespace: str,
        payload: dict[str, Any],
        client_origin: str,
        state: int = TaskResource.STATE_ACTIVE,
        project_id: int = 0,
        is_group_chat: bool = False,
    ) -> TaskResource: ...

    def get_by_id(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> Optional[TaskResource]: ...

    def get_active_task(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: Optional[int] = None,
        client_origin: Optional[str] = None,
    ) -> Optional[TaskResource]: ...

    def get_non_deleted_task(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: Optional[int] = None,
    ) -> Optional[TaskResource]: ...

    def get_regular_active_task(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: Optional[int] = None,
        client_origin: Optional[str] = None,
    ) -> Optional[TaskResource]: ...

    def get_owned_active_task(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        client_origin: Optional[str] = None,
    ) -> Optional[TaskResource]: ...

    def get_owned_task_by_name(
        self,
        db: Session,
        *,
        user_id: int,
        name: str,
        namespace: str,
    ) -> Optional[TaskResource]: ...

    def get_active_non_deleted_task(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: Optional[int] = None,
        client_origin: Optional[str] = None,
    ) -> Optional[TaskResource]: ...

    def get_active_or_archived_task(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: Optional[int] = None,
        client_origin: Optional[str] = None,
    ) -> Optional[TaskResource]: ...

    def get_task_by_states(
        self,
        db: Session,
        *,
        task_id: int,
        states: Sequence[int],
        kind: str = "Task",
        user_id: Optional[int] = None,
        owner_user_id: Optional[int] = None,
        client_origin: Optional[str] = None,
    ) -> Optional[TaskResource]: ...

    def get_owned_task_by_state(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        state: int,
        client_origin: Optional[str] = None,
    ) -> Optional[TaskResource]: ...

    def get_task_by_workspace_ref(
        self,
        db: Session,
        *,
        user_id: int,
        workspace_name: str,
        workspace_namespace: str,
    ) -> Optional[TaskResource]: ...

    def get_workspace_by_ref(
        self,
        db: Session,
        *,
        user_id: int,
        name: str,
        namespace: str,
    ) -> Optional[TaskResource]: ...

    def get_active_workspace_by_id(
        self,
        db: Session,
        *,
        workspace_id: int,
        owner_user_id: Optional[int] = None,
    ) -> Optional[TaskResource]: ...

    def get_owned_active_workspace_by_id(
        self, db: Session, *, workspace_id: int, user_id: int
    ) -> Optional[TaskResource]: ...

    def list_active_workspaces_by_ids(
        self,
        db: Session,
        *,
        workspace_ids: Sequence[int],
        owner_user_id: Optional[int] = None,
    ) -> list[TaskResource]: ...

    def list_active_workspaces_by_user(
        self, db: Session, *, user_id: int
    ) -> list[TaskResource]: ...

    def list_by_ids(
        self,
        db: Session,
        *,
        task_ids: Sequence[int],
        owner_user_id: Optional[int] = None,
    ) -> list[TaskResource]: ...

    def list_recent_group_chat_tasks(
        self,
        db: Session,
        *,
        since: datetime,
    ) -> list[TaskResource]: ...

    def list_regular_active_tasks(
        self,
        db: Session,
        *,
        user_id: Optional[int] = None,
        user_ids: Optional[Sequence[int]] = None,
        client_origin: Optional[str] = None,
        exclude_system_namespace: bool = False,
        limit: Optional[int] = None,
        order_by_id_desc: bool = False,
        order_by_updated_at_desc: bool = False,
    ) -> list[TaskResource]: ...

    def list_kind_resources(
        self,
        db: Session,
        *,
        kind: str,
        user_id: int,
        namespace: str,
        name: Optional[str] = None,
    ) -> list[TaskResource]: ...

    def get_kind_resource(
        self,
        db: Session,
        *,
        kind: str,
        user_id: int,
        namespace: str,
        name: str,
    ) -> Optional[TaskResource]: ...

    def create_kind_resource(
        self,
        db: Session,
        *,
        user_id: int,
        kind: str,
        name: str,
        namespace: str,
        payload: dict[str, Any],
    ) -> TaskResource: ...

    def list_owned_tasks_by_ids_and_states(
        self,
        db: Session,
        *,
        task_ids: Sequence[int],
        user_id: int,
        states: Sequence[int],
        client_origin: Optional[str] = None,
    ) -> list[TaskResource]: ...

    def list_by_ids_ordered(
        self,
        db: Session,
        *,
        task_ids: Sequence[int],
        owner_user_id: Optional[int] = None,
        order_field: str = "updated_at",
        descending: bool = True,
        skip: int = 0,
        limit: Optional[int] = None,
        exclude_deleted: bool = False,
    ) -> list[TaskResource]: ...

    def list_workspaces_by_refs(
        self, db: Session, *, refs: Sequence[WorkspaceRefLookup]
    ) -> list[TaskResource]: ...

    def list_accessible_task_ids(
        self, db: Session, *, user_id: int, skip: int, limit: int, extra_limit: int
    ) -> tuple[list[int], int]: ...

    def list_owned_task_ids(
        self, db: Session, *, user_id: int, skip: int, limit: int, extra_limit: int
    ) -> tuple[list[int], int]: ...

    def list_personal_task_ids(
        self,
        db: Session,
        *,
        user_id: int,
        skip: int,
        limit: int,
        extra_limit: int,
        client_origin: Optional[str] = None,
        project_scope: Literal["all", "standalone", "standalone_unlabeled"] = "all",
    ) -> tuple[list[int], int]: ...

    def list_group_task_ids_for_accessible_user(
        self, db: Session, *, user_id: int
    ) -> set[int]: ...

    def list_group_task_ids_for_owned_tasks(
        self, db: Session, *, user_id: int
    ) -> set[int]: ...

    def list_active_tasks_for_user(
        self, db: Session, *, user_id: int
    ) -> list[TaskResource]: ...

    def list_accessible_active_tasks_for_user(
        self, db: Session, *, user_id: int
    ) -> list[TaskResource]: ...

    def count_non_deleted_by_ids(
        self,
        db: Session,
        *,
        task_ids: Sequence[int],
        owner_user_id: Optional[int] = None,
    ) -> int: ...

    def count_active_project_tasks(
        self,
        db: Session,
        *,
        project_id: int,
        owner_user_id: Optional[int] = None,
        client_origin: Optional[str] = None,
    ) -> int: ...

    def list_active_project_tasks(
        self,
        db: Session,
        *,
        project_id: int,
        owner_user_id: Optional[int] = None,
        client_origin: Optional[str] = None,
    ) -> list[TaskResource]: ...

    def get_active_project_task(
        self,
        db: Session,
        *,
        task_id: int,
        project_id: int,
        owner_user_id: Optional[int] = None,
        client_origin: Optional[str] = None,
    ) -> Optional[TaskResource]: ...

    def list_archived_tasks(
        self,
        db: Session,
        *,
        user_id: int,
        skip: int = 0,
        limit: int = 100,
        client_origin: Optional[str] = None,
    ) -> tuple[list[TaskResource], int]: ...

    def list_archivable_active_tasks(
        self,
        db: Session,
        *,
        user_id: int,
        scope: Literal["all", "standalone", "project", "project_id"],
        project_id: Optional[int] = None,
        client_origin: Optional[str] = None,
    ) -> list[TaskResource]: ...

    def list_archived_task_ids(
        self,
        db: Session,
        *,
        user_id: int,
        client_origin: Optional[str] = None,
    ) -> list[int]: ...

    def update_json(
        self, db: Session, *, task: TaskResource, payload: dict[str, Any]
    ) -> TaskResource: ...

    def update_fields(
        self, db: Session, *, task: TaskResource, **fields: Any
    ) -> TaskResource: ...

    def clear_project_for_owned_tasks(
        self,
        db: Session,
        *,
        project_id: int,
        user_id: int,
        client_origin: Optional[str] = None,
    ) -> int: ...

    def restore_stale_project_links_from_label(
        self,
        db: Session,
        *,
        user_id: int,
        client_origin: str,
        project_id: int,
    ) -> int: ...

    def set_archive_state(
        self, db: Session, *, task: TaskResource, state: int, commit: bool = True
    ) -> None: ...

    def soft_delete_task(
        self, db: Session, *, task: TaskResource, payload: dict[str, Any]
    ) -> TaskResource: ...

    def delete_resource(self, db: Session, *, resource: TaskResource) -> None: ...


class SubtaskStore(Protocol):
    """Data access boundary for task conversation messages."""

    def create_user_subtask(
        self,
        db: Session,
        *,
        user_id: int,
        task_id: int,
        team_id: int,
        title: str,
        bot_ids: list[int],
        prompt: str,
        message_id: int,
        parent_id: int,
        sender_user_id: int = 0,
        result: Optional[dict[str, Any]] = None,
        progress: int = 100,
    ) -> Subtask: ...

    def create_assistant_subtask(
        self,
        db: Session,
        *,
        user_id: int,
        task_id: int,
        team_id: int,
        title: str,
        bot_ids: list[int],
        message_id: int,
        parent_id: int,
    ) -> Subtask: ...

    def create_user_and_assistant_subtasks(
        self,
        db: Session,
        *,
        user_id: int,
        task_id: int,
        team_id: int,
        title: str,
        assistant_title: str,
        bot_ids: list[int],
        prompt: str,
        user_message_id: int,
        user_parent_id: int,
        assistant_message_id: int,
        assistant_parent_id: int,
        sender_user_id: int = 0,
        result: Optional[dict[str, Any]] = None,
        progress: int = 100,
    ) -> tuple[Subtask, Subtask]: ...

    def create_subtask(
        self,
        db: Session,
        *,
        user_id: int,
        task_id: int,
        team_id: int,
        title: str,
        bot_ids: list[int],
        role: SubtaskRole,
        prompt: Optional[str],
        executor_namespace: Optional[str],
        executor_name: Optional[str],
        message_id: int,
        parent_id: Optional[int],
        status: SubtaskStatus,
        progress: int,
        result: Optional[dict[str, Any]],
        error_message: Optional[str],
    ) -> Subtask: ...

    def get_by_id(
        self, db: Session, *, subtask_id: int, owner_user_id: Optional[int] = None
    ) -> Optional[Subtask]: ...

    def get_basic_by_id(
        self, db: Session, *, subtask_id: int, owner_user_id: Optional[int] = None
    ) -> Optional[Subtask]: ...

    def get_by_id_and_role(
        self,
        db: Session,
        *,
        subtask_id: int,
        role: SubtaskRole,
        owner_user_id: Optional[int] = None,
    ) -> Optional[Subtask]: ...

    def get_accessible_by_id(
        self,
        db: Session,
        *,
        subtask_id: int,
        user_id: int,
        access_store: "TaskAccessStore",
    ) -> Optional[Subtask]: ...

    def list_by_task(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        access_store: "TaskAccessStore",
        skip: int = 0,
        limit: int = 100,
        from_latest: bool = False,
        before_message_id: Optional[int] = None,
    ) -> list[Subtask]: ...

    def count_by_task_for_user(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        access_store: "TaskAccessStore",
    ) -> int: ...

    def list_by_user(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> list[Subtask]: ...

    def list_latest_by_task(
        self, db: Session, *, task_id: int, user_id: int, limit: int = 100
    ) -> list[Subtask]: ...

    def list_new_messages_since(
        self,
        db: Session,
        *,
        task_id: int,
        owner_user_id: Optional[int] = None,
        last_subtask_id: Optional[int] = None,
        since: Optional[datetime] = None,
    ) -> list[Subtask]: ...

    def get_latest_for_user(
        self, db: Session, *, task_id: int, user_id: int
    ) -> Optional[Subtask]: ...

    def get_first_by_task(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> Optional[Subtask]: ...

    def get_next_message_id(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> int: ...

    def get_running_assistant_for_user(
        self, db: Session, *, task_id: int, user_id: int
    ) -> Optional[Subtask]: ...

    def get_latest_assistant_for_user_by_statuses(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
        statuses: Sequence[SubtaskStatus],
    ) -> Optional[Subtask]: ...

    def get_latest_assistant_by_statuses(
        self,
        db: Session,
        *,
        task_id: int,
        statuses: Sequence[SubtaskStatus],
        owner_user_id: Optional[int] = None,
    ) -> Optional[Subtask]: ...

    def get_latest_running_assistant_by_task(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> Optional[Subtask]: ...

    def list_by_task_unfiltered(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> list[Subtask]: ...

    def list_ids_by_task(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: Optional[int] = None,
        owner_user_id: Optional[int] = None,
    ) -> list[int]: ...

    def list_by_task_desc(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> list[Subtask]: ...

    def list_completed_before_message_id(
        self,
        db: Session,
        *,
        task_id: int,
        before_message_id: int,
        owner_user_id: Optional[int] = None,
    ) -> list[Subtask]: ...

    def get_retry_assistant(
        self,
        db: Session,
        *,
        task_id: int,
        subtask_id: int,
        owner_user_id: Optional[int] = None,
    ) -> Optional[Subtask]: ...

    def get_user_by_task_message_id(
        self,
        db: Session,
        *,
        task_id: int,
        message_id: int,
        owner_user_id: Optional[int] = None,
    ) -> Optional[Subtask]: ...

    def get_first_user_before_message_id(
        self,
        db: Session,
        *,
        task_id: int,
        before_message_id: int,
        owner_user_id: Optional[int] = None,
    ) -> Optional[Subtask]: ...

    def get_by_task_message_id_and_role(
        self,
        db: Session,
        *,
        task_id: int,
        message_id: int,
        role: SubtaskRole,
        owner_user_id: Optional[int] = None,
    ) -> Optional[Subtask]: ...

    def get_by_task_parent_id_and_role(
        self,
        db: Session,
        *,
        task_id: int,
        parent_id: int,
        role: SubtaskRole,
        owner_user_id: Optional[int] = None,
    ) -> Optional[Subtask]: ...

    def list_assistant_by_task(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> list[Subtask]: ...

    def list_after_message_id(
        self,
        db: Session,
        *,
        task_id: int,
        after_message_id: int,
        owner_user_id: Optional[int] = None,
    ) -> list[Subtask]: ...

    def get_latest_by_task(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> Optional[Subtask]: ...

    def list_by_task_ordered(
        self,
        db: Session,
        *,
        task_id: int,
        message_ids: Optional[Sequence[int]] = None,
        exclude_subtask_ids: Optional[Sequence[int]] = None,
        exclude_deleted: bool = False,
        order_by: Literal["id", "message_id", "created_at"] = "message_id",
        owner_user_id: Optional[int] = None,
    ) -> list[Subtask]: ...

    def list_recent_by_task_ids(
        self,
        db: Session,
        *,
        task_ids: Sequence[int],
        limit: int,
        owner_user_id: Optional[int] = None,
    ) -> list[Subtask]: ...

    def search_task_ids_by_content(
        self,
        db: Session,
        *,
        task_ids: Sequence[int],
        keyword: str,
        owner_user_id: Optional[int] = None,
    ) -> set[int]: ...

    def list_by_task_for_user_ordered(
        self,
        db: Session,
        *,
        task_id: int,
        user_id: int,
    ) -> list[Subtask]: ...

    def list_by_task_status(
        self,
        db: Session,
        *,
        task_id: int,
        status: SubtaskStatus,
        owner_user_id: Optional[int] = None,
    ) -> list[Subtask]: ...

    def list_by_task_statuses(
        self,
        db: Session,
        *,
        task_id: int,
        statuses: Sequence[SubtaskStatus],
        owner_user_id: Optional[int] = None,
    ) -> list[Subtask]: ...

    def list_not_executor_deleted_by_task(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> list[Subtask]: ...

    def list_history_by_task_statuses(
        self,
        db: Session,
        *,
        task_id: int,
        statuses: Sequence[SubtaskStatus],
        before_message_id: Optional[int] = None,
        limit: Optional[int] = None,
        owner_user_id: Optional[int] = None,
    ) -> list[Subtask]: ...

    def get_latest_device_executor_for_task(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> Optional[Subtask]: ...

    def get_latest_active_executor_for_task(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> Optional[Subtask]: ...

    def list_running_device_subtasks(self, db: Session) -> list[Subtask]: ...

    def list_running_by_executor_name(
        self, db: Session, *, executor_name: str
    ) -> list[Subtask]: ...

    def list_by_executor_ref(
        self, db: Session, *, executor_namespace: str, executor_name: str
    ) -> list[Subtask]: ...

    def list_running(self, db: Session) -> list[Subtask]: ...

    def list_session_task_ids(
        self, db: Session, *, skip: int, limit: int
    ) -> list[int]: ...

    def get_cleanup_cursor_recent_start_reference(
        self, db: Session, *, recent_threshold: datetime
    ) -> Optional[Subtask]: ...

    def get_cleanup_cursor_latest_reference(self, db: Session) -> Optional[Subtask]: ...

    def list_runtime_cleanup_subtasks(self, db: Session) -> list[Subtask]: ...

    def scan_cleanup_candidate_subtasks(
        self, db: Session, *, last_id: int, cutoff: datetime, limit: int
    ) -> list[Subtask]: ...

    def scan_cleanup_lookback_subtasks(
        self,
        db: Session,
        *,
        lookback_start: datetime,
        cutoff: datetime,
        limit: int,
    ) -> list[Subtask]: ...

    def list_cleanup_subtasks_for_task(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> list[Subtask]: ...

    def update_status(
        self,
        db: Session,
        *,
        subtask: Subtask,
        status: SubtaskStatus,
        completed_at: Optional[datetime] = None,
    ) -> Subtask: ...

    def update_result(
        self, db: Session, *, subtask: Subtask, result: Any
    ) -> Subtask: ...

    def update_error(
        self, db: Session, *, subtask: Subtask, error_message: str
    ) -> Subtask: ...

    def update_executor_info(
        self,
        db: Session,
        *,
        subtask: Subtask,
        executor_namespace: str,
        executor_name: str,
    ) -> Subtask: ...

    def update_progress(
        self, db: Session, *, subtask: Subtask, progress: int
    ) -> Subtask: ...

    def update_fields(
        self, db: Session, *, subtask: Subtask, **fields: Any
    ) -> Subtask: ...

    def has_running_assistant(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> bool: ...

    def mark_executor_deleted(
        self, db: Session, *, executor_namespace: str, executor_name: str
    ) -> int: ...

    def mark_executor_deleted_by_ids(
        self, db: Session, *, subtask_ids: Sequence[int]
    ) -> int: ...

    def mark_task_subtasks_deleted(
        self, db: Session, *, task_id: int, owner_user_id: Optional[int] = None
    ) -> int: ...

    def mark_task_messages_status(
        self,
        db: Session,
        *,
        task_id: int,
        status: SubtaskStatus,
        owner_user_id: Optional[int] = None,
    ) -> int: ...

    def mark_task_subtasks_by_statuses(
        self,
        db: Session,
        *,
        task_id: int,
        from_statuses: Sequence[SubtaskStatus],
        to_status: SubtaskStatus,
        progress: Optional[int] = None,
        completed_at: Optional[datetime] = None,
        owner_user_id: Optional[int] = None,
    ) -> int: ...

    def delete(self, db: Session, *, subtask: Subtask) -> None: ...

    def delete_from_message_id(
        self,
        db: Session,
        *,
        task_id: int,
        from_message_id: int,
        owner_user_id: Optional[int] = None,
    ) -> int: ...

    def delete_after_message_id(
        self,
        db: Session,
        *,
        task_id: int,
        after_message_id: int,
        owner_user_id: Optional[int] = None,
    ) -> int: ...


class TaskAccessStore(Protocol):
    """Access checks for task ownership and group membership."""

    def get_task(self, db: Session, *, task_id: int) -> Optional[TaskResource]: ...

    def get_task_owner_id(self, db: Session, *, task_id: int) -> Optional[int]: ...

    def is_task_owner(self, db: Session, *, task_id: int, user_id: int) -> bool: ...

    def is_member(self, db: Session, *, task_id: int, user_id: int) -> bool: ...

    def is_group_chat(self, db: Session, *, task_id: int) -> bool: ...

    def list_member_task_ids(self, db: Session, *, user_id: int) -> set[int]: ...
