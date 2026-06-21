# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Create task-level forks without copying subtasks."""

from copy import deepcopy
from datetime import datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.task import TaskResource
from app.schemas.kind import Task, Workspace
from app.schemas.task_fork import DeviceTaskForkTarget, TaskForkRequest
from app.services.task_fork_history import task_fork_history_resolver
from app.stores.tasks import task_access_store, task_store

RUNNING_TASK_STATUSES = {"PENDING", "RUNNING", "CANCELLING"}


class TaskForkService:
    """Create linked task forks that inherit parent history by metadata."""

    def fork_task(
        self,
        *,
        db: Session,
        source_task_id: int,
        user_id: int,
        request: TaskForkRequest,
        client_origin: str,
    ) -> TaskResource:
        source_task = task_store.get_active_non_deleted_task(
            db,
            task_id=source_task_id,
            client_origin=client_origin,
        )
        if not source_task or not task_access_store.is_member(
            db,
            task_id=source_task_id,
            user_id=user_id,
        ):
            raise HTTPException(status_code=404, detail="task_not_found")

        if source_task.user_id != user_id:
            raise HTTPException(status_code=403, detail="cross_user_fork_not_supported")

        source_crd = Task.model_validate(source_task.json)
        source_status = source_crd.status.status if source_crd.status else "PENDING"
        if source_status in RUNNING_TASK_STATUSES:
            raise HTTPException(status_code=409, detail="task_is_running")

        target_device_id = self._resolve_target_device_id(
            db=db,
            source_crd=source_crd,
            user_id=user_id,
            request=request,
        )
        history_items = task_fork_history_resolver.resolve_for_task(
            db,
            task_id=source_task_id,
            user_id=user_id,
        )
        after_message_id = self._resolve_after_message_id(history_items)
        fork_runtime = self._extract_runtime_from_history(history_items)
        root_task_id = (
            source_crd.spec.fork.rootTaskId if source_crd.spec.fork else source_task_id
        )
        workspace_archive = self._extract_workspace_archive(
            source_json=source_task.json,
            source_task_id=source_task_id,
        )

        def workspace_factory(task_id_value: int) -> tuple[str, str, dict[str, Any]]:
            workspace_name = f"workspace-{task_id_value}"
            workspace_json = self._build_workspace_json(
                db=db,
                source_crd=source_crd,
                source_user_id=source_task.user_id,
                workspace_name=workspace_name,
                source_task_id=source_task_id,
            )
            return workspace_name, "default", workspace_json

        new_task, _workspace = task_store.create_pending_task_shell_with_workspace(
            db,
            user_id=user_id,
            client_origin=client_origin,
            workspace_factory=workspace_factory,
            is_group_chat=source_crd.spec.is_group_chat,
            project_id=source_task.project_id or 0,
        )
        if not new_task.id:
            raise HTTPException(status_code=500, detail="fork_task_id_creation_failed")

        new_crd_dict = self._build_fork_task_json(
            source_json=source_task.json,
            new_task_id=new_task.id,
            source_task_id=source_task_id,
            after_message_id=after_message_id,
            root_task_id=root_task_id,
            target_device_id=target_device_id,
            fork_runtime=fork_runtime,
            workspace_archive=workspace_archive,
        )
        task_store.update_json(db, task=new_task, payload=new_crd_dict)
        db.commit()
        db.refresh(new_task)
        return new_task

    def _resolve_target_device_id(
        self,
        *,
        db: Session,
        source_crd: Task,
        user_id: int,
        request: TaskForkRequest,
    ) -> str | None:
        if isinstance(request.target, DeviceTaskForkTarget):
            self._validate_device_target(
                db,
                user_id=user_id,
                device_id=request.target.device_id,
            )
            return request.target.device_id

        self._validate_managed_target(source_crd)
        return None

    def _build_fork_task_json(
        self,
        *,
        source_json: dict[str, Any],
        new_task_id: int,
        source_task_id: int,
        after_message_id: int,
        root_task_id: int,
        target_device_id: str | None,
        fork_runtime: dict[str, Any] | None,
        workspace_archive: dict[str, Any] | None,
    ) -> dict[str, Any]:
        now = datetime.now().isoformat()
        new_crd_dict = deepcopy(source_json)
        new_crd_dict["metadata"]["name"] = f"task-{new_task_id}"
        new_crd_dict["spec"]["workspaceRef"] = {
            "name": f"workspace-{new_task_id}",
            "namespace": "default",
        }
        new_crd_dict["spec"]["fork"] = {
            "sourceTaskId": source_task_id,
            "afterMessageId": after_message_id,
            "rootTaskId": root_task_id,
        }
        combined_runtime = deepcopy(fork_runtime) if fork_runtime else {}
        if workspace_archive:
            combined_runtime["workspaceArchive"] = {
                "sourceTaskId": source_task_id,
                "storageKey": workspace_archive["storageKey"],
            }
        if combined_runtime:
            new_crd_dict["spec"]["fork"]["runtime"] = combined_runtime
        if target_device_id:
            new_crd_dict["spec"]["device_id"] = target_device_id
        else:
            new_crd_dict["spec"].pop("device_id", None)

        new_crd_dict["status"] = {
            "state": "Available",
            "status": "COMPLETED",
            "progress": 100,
            "createdAt": now,
            "updatedAt": now,
        }
        if workspace_archive:
            new_crd_dict["status"]["archive"] = workspace_archive
        return new_crd_dict

    def _build_workspace_json(
        self,
        *,
        db: Session,
        source_crd: Task,
        source_user_id: int,
        workspace_name: str,
        source_task_id: int,
    ) -> dict[str, Any]:
        repository = {
            "gitUrl": "",
            "gitRepo": "",
            "gitRepoId": 0,
            "gitDomain": "",
            "branchName": "",
        }
        source_workspace = task_store.get_workspace_by_ref(
            db,
            user_id=source_user_id,
            name=source_crd.spec.workspaceRef.name,
            namespace=source_crd.spec.workspaceRef.namespace,
        )
        if source_workspace and source_workspace.json:
            workspace_crd = Workspace.model_validate(source_workspace.json)
            repository = workspace_crd.spec.repository.model_dump(mode="json")

        return {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Workspace",
            "metadata": {
                "name": workspace_name,
                "namespace": "default",
                "labels": {"forkedFromTaskId": str(source_task_id)},
            },
            "spec": {"repository": repository},
            "status": {"state": "Available"},
        }

    def _resolve_after_message_id(
        self,
        history_items: list[Any],
    ) -> int:
        return max((item.subtask.message_id for item in history_items), default=0)

    def _extract_runtime_from_history(
        self,
        history_items: list[Any],
    ) -> dict[str, Any] | None:
        sessions: list[dict[str, Any]] = []
        seen: set[tuple[str, str, str]] = set()

        for item in history_items:
            result = getattr(getattr(item, "subtask", None), "result", None)
            if not isinstance(result, dict):
                continue
            session = result.get("executor_session")
            normalized = self._normalize_executor_session(session)
            if not normalized:
                continue
            identity = (
                str(normalized.get("agent") or ""),
                str(normalized.get("sessionId") or ""),
                str(normalized.get("threadId") or ""),
            )
            if identity in seen:
                continue
            seen.add(identity)
            sessions.append(normalized)

        if not sessions:
            return None
        return {"sessions": sessions}

    @staticmethod
    def _extract_workspace_archive(
        *,
        source_json: dict[str, Any],
        source_task_id: int,
    ) -> dict[str, Any] | None:
        status = (
            source_json.get("status")
            if isinstance(source_json.get("status"), dict)
            else {}
        )
        archive = status.get("archive")
        if not isinstance(archive, dict):
            return None
        storage_key = archive.get("storageKey")
        if not isinstance(storage_key, str) or not storage_key.strip():
            return None
        normalized = deepcopy(archive)
        normalized["storageKey"] = storage_key.strip()
        return normalized

    @staticmethod
    def _normalize_executor_session(session: Any) -> dict[str, Any] | None:
        if not isinstance(session, dict):
            return None
        agent = session.get("agent")
        session_id = session.get("sessionId")
        thread_id = session.get("threadId")
        if not agent or not (session_id or thread_id):
            return None

        normalized: dict[str, Any] = {"agent": str(agent)}
        if session_id:
            normalized["sessionId"] = str(session_id)
        if thread_id:
            normalized["threadId"] = str(thread_id)
        if session.get("botId") is not None:
            normalized["botId"] = session["botId"]
        return normalized

    def _validate_device_target(
        self,
        db: Session,
        *,
        user_id: int,
        device_id: str,
    ) -> None:
        from app.models.kind import Kind

        device = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Device",
                Kind.namespace == "default",
                Kind.name == device_id,
                Kind.is_active == True,
            )
            .first()
        )
        if not device:
            raise HTTPException(status_code=403, detail="device_not_allowed")

        spec = device.json.get("spec", {}) if isinstance(device.json, dict) else {}
        if spec.get("status") == "offline":
            raise HTTPException(status_code=409, detail="device_offline")

    def _validate_managed_target(self, source_crd: Task) -> None:
        execution = source_crd.spec.execution
        workspace = execution.workspace if execution else None
        if workspace and workspace.source == "local_path":
            archive = source_crd.status.archive if source_crd.status else None
            if archive and archive.storageKey:
                return
            raise HTTPException(
                status_code=409,
                detail="workspace_not_available_for_target",
            )


task_fork_service = TaskForkService()
