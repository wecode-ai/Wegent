# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
import logging
import posixpath
from typing import Any, Optional
from urllib.parse import quote

import httpx
from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.core.config import settings
from app.schemas.remote_workspace import (
    RemoteWorkspaceStatusResponse,
    RemoteWorkspaceTreeEntry,
    RemoteWorkspaceTreeResponse,
)
from app.services.adapters.task_kinds import task_kinds_service

WORKSPACE_ROOT = "/workspace"
SANDBOX_HOME_ROOT = "/home/user"
SANDBOX_RUNNING_STATUS = "running"
LOG_PREVIEW_LIMIT = 300
logger = logging.getLogger(__name__)


def _build_task_workspace_root(task_id: int) -> str:
    return posixpath.join(WORKSPACE_ROOT, str(task_id))


class RemoteWorkspaceService:
    def __init__(
        self,
        executor_manager_url: Optional[str] = None,
        request_timeout: float = 5.0,
    ):
        self.executor_manager_url = (
            executor_manager_url or settings.EXECUTOR_MANAGER_URL
        ).rstrip("/")
        self.request_timeout = request_timeout

    def get_status(
        self,
        db: Session,
        task_id: int,
        user_id: int,
    ) -> RemoteWorkspaceStatusResponse:
        task_detail = self._get_task_detail(db=db, task_id=task_id, user_id=user_id)
        sandbox_payload = self._get_sandbox_payload(task_id=task_id)
        connected = self._has_executor_binding(task_detail) or bool(sandbox_payload)

        if not connected:
            logger.info(
                "[remote_workspace] status not connected task_id=%s user_id=%s",
                task_id,
                user_id,
            )
            return RemoteWorkspaceStatusResponse(
                connected=False,
                available=False,
                root_path=_build_task_workspace_root(task_id),
                reason="not_connected",
            )

        base_url = self._resolve_workspace_base_url(
            task_id=task_id,
            task_detail=task_detail,
            sandbox_payload=sandbox_payload,
        )
        available = bool(base_url)
        reason = None if available else "sandbox_not_running"
        root_path = self._resolve_root_path(
            task_id=task_id, sandbox_payload=sandbox_payload
        )
        logger.info(
            "[remote_workspace] status resolved task_id=%s user_id=%s connected=%s available=%s base_url=%s reason=%s root_path=%s",
            task_id,
            user_id,
            connected,
            available,
            base_url,
            reason,
            root_path,
        )

        return RemoteWorkspaceStatusResponse(
            connected=True,
            available=available,
            root_path=root_path,
            reason=reason,
        )

    def list_tree(
        self,
        db: Session,
        task_id: int,
        user_id: int,
        path: Optional[str] = None,
    ) -> RemoteWorkspaceTreeResponse:
        sandbox_payload = self._get_sandbox_payload(task_id=task_id)
        root_path = self._resolve_root_path(
            task_id=task_id, sandbox_payload=sandbox_payload
        )
        normalized_path = self.normalize_and_validate_workspace_path(
            path, root_path=root_path
        )
        self._get_task_detail(db=db, task_id=task_id, user_id=user_id)
        logger.info(
            "[remote_workspace] list_tree start task_id=%s user_id=%s path=%s normalized_path=%s root_path=%s",
            task_id,
            user_id,
            path,
            normalized_path,
            root_path,
        )
        if self._is_sandbox_available(sandbox_payload):
            sandbox_base_url = str(sandbox_payload.get("base_url", "")).rstrip("/")
            entries_payload = self._list_directory_via_sandbox(
                base_url=sandbox_base_url,
                path=normalized_path,
            )
        else:
            executor_name = self._ensure_sandbox_available(
                db=db,
                task_id=task_id,
                user_id=user_id,
            )
            entries_payload = self._list_directory(
                task_id=task_id,
                executor_name=executor_name,
                path=normalized_path,
            )

        entries: list[RemoteWorkspaceTreeEntry] = []
        for item in entries_payload:
            entries.append(
                RemoteWorkspaceTreeEntry(
                    name=str(item.get("name", "")),
                    path=str(item.get("path", normalized_path)),
                    is_directory=bool(item.get("is_directory", False)),
                    size=int(item.get("size", 0) or 0),
                    modified_at=item.get("modified_at"),
                )
            )

        logger.info(
            "[remote_workspace] list_tree success task_id=%s user_id=%s normalized_path=%s entry_count=%s base_url=%s",
            task_id,
            user_id,
            normalized_path,
            len(entries),
            sandbox_payload.get("base_url") if sandbox_payload else None,
        )
        return RemoteWorkspaceTreeResponse(path=normalized_path, entries=entries)

    def stream_file(
        self,
        db: Session,
        task_id: int,
        user_id: int,
        path: str,
        disposition: str = "inline",
    ) -> StreamingResponse:
        if disposition not in {"inline", "attachment"}:
            raise HTTPException(status_code=400, detail="Invalid disposition")

        sandbox_payload = self._get_sandbox_payload(task_id=task_id)
        root_path = self._resolve_root_path(
            task_id=task_id, sandbox_payload=sandbox_payload
        )
        normalized_path = self.normalize_and_validate_workspace_path(
            path, root_path=root_path
        )
        self._get_task_detail(db=db, task_id=task_id, user_id=user_id)
        logger.info(
            "[remote_workspace] stream_file start task_id=%s user_id=%s path=%s normalized_path=%s disposition=%s root_path=%s",
            task_id,
            user_id,
            path,
            normalized_path,
            disposition,
            root_path,
        )
        if self._is_sandbox_available(sandbox_payload):
            sandbox_base_url = str(sandbox_payload.get("base_url", "")).rstrip("/")
            content, content_type = self._download_file_via_sandbox(
                base_url=sandbox_base_url,
                path=normalized_path,
            )
        else:
            executor_name = self._ensure_sandbox_available(
                db=db,
                task_id=task_id,
                user_id=user_id,
            )
            content, content_type = self._download_file(
                task_id=task_id,
                executor_name=executor_name,
                path=normalized_path,
            )

        filename = posixpath.basename(normalized_path) or "download"
        response = StreamingResponse(
            iter([content]),
            media_type=content_type or "application/octet-stream",
        )
        response.headers["Content-Disposition"] = self._build_content_disposition(
            disposition=disposition,
            filename=filename,
        )
        logger.info(
            "[remote_workspace] stream_file success task_id=%s user_id=%s normalized_path=%s content_type=%s size=%s base_url=%s",
            task_id,
            user_id,
            normalized_path,
            content_type,
            len(content),
            sandbox_payload.get("base_url") if sandbox_payload else None,
        )
        return response

    def _build_content_disposition(self, disposition: str, filename: str) -> str:
        try:
            filename.encode("latin-1")
        except UnicodeEncodeError:
            encoded_filename = quote(filename)
            return f"{disposition}; filename*=UTF-8''{encoded_filename}"

        escaped_filename = filename.replace("\\", "\\\\").replace('"', '\\"')
        return f'{disposition}; filename="{escaped_filename}"'

    def _get_task_detail(
        self, db: Session, task_id: int, user_id: int
    ) -> dict[str, Any]:
        return task_kinds_service.get_task_detail(
            db=db, task_id=task_id, user_id=user_id
        )

    def _get_connected_executor_binding(
        self, task_detail: dict[str, Any]
    ) -> Optional[tuple[str, str]]:
        subtasks = task_detail.get("subtasks") or []
        latest_deleted_binding: Optional[tuple[str, str]] = None

        for subtask in reversed(subtasks):
            if not isinstance(subtask, dict):
                continue

            executor_name = subtask.get("executor_name")
            if not isinstance(executor_name, str):
                continue

            normalized_executor_name = executor_name.strip()
            if not normalized_executor_name:
                continue

            executor_namespace = subtask.get("executor_namespace")
            normalized_executor_namespace = (
                executor_namespace.strip()
                if isinstance(executor_namespace, str)
                else ""
            )

            if not bool(subtask.get("executor_deleted_at", False)):
                return normalized_executor_name, normalized_executor_namespace

            if latest_deleted_binding is None:
                latest_deleted_binding = (
                    normalized_executor_name,
                    normalized_executor_namespace,
                )

        return latest_deleted_binding

    def _get_connected_executor_name(
        self, task_detail: dict[str, Any]
    ) -> Optional[str]:
        binding = self._get_connected_executor_binding(task_detail)
        if binding is None:
            return None
        return binding[0]

    def _has_executor_binding(self, task_detail: dict[str, Any]) -> bool:
        return self._get_connected_executor_binding(task_detail) is not None

    def _resolve_workspace_base_url(
        self,
        task_id: int,
        task_detail: dict[str, Any],
        sandbox_payload: Optional[dict[str, Any]] = None,
    ) -> Optional[str]:
        if sandbox_payload is None:
            sandbox_payload = self._get_sandbox_payload(task_id=task_id)
        if self._is_sandbox_available(sandbox_payload):
            sandbox_base_url = sandbox_payload.get("base_url")
            if isinstance(sandbox_base_url, str) and sandbox_base_url:
                logger.info(
                    "[remote_workspace] base_url resolved via sandbox task_id=%s base_url=%s",
                    task_id,
                    sandbox_base_url,
                )
                return sandbox_base_url.rstrip("/")

        executor_binding = self._get_connected_executor_binding(task_detail)
        if not executor_binding:
            logger.info(
                "[remote_workspace] base_url unresolved task_id=%s reason=no_executor_binding",
                task_id,
            )
            return None
        executor_name, executor_namespace = executor_binding

        logger.info(
            "[remote_workspace] base_url fallback to executor task_id=%s executor_name=%s executor_namespace=%s",
            task_id,
            executor_name,
            executor_namespace,
        )
        executor_payload = self._get_executor_payload(
            executor_name=executor_name,
            executor_namespace=executor_namespace,
        )
        if not executor_payload:
            logger.warning(
                "[remote_workspace] base_url unresolved task_id=%s executor_name=%s executor_namespace=%s reason=empty_executor_payload",
                task_id,
                executor_name,
                executor_namespace,
            )
            return None

        status = str(executor_payload.get("status", "")).lower()
        base_url = executor_payload.get("base_url")
        if not isinstance(base_url, str) or not base_url:
            logger.warning(
                "[remote_workspace] base_url unresolved task_id=%s executor_name=%s executor_namespace=%s reason=missing_base_url payload=%s",
                task_id,
                executor_name,
                executor_namespace,
                executor_payload,
            )
            return None
        if status and status != "success":
            logger.warning(
                "[remote_workspace] base_url unresolved task_id=%s executor_name=%s executor_namespace=%s reason=non_success_status status=%s payload=%s",
                task_id,
                executor_name,
                executor_namespace,
                status,
                executor_payload,
            )
            return None

        logger.info(
            "[remote_workspace] base_url resolved via executor task_id=%s executor_name=%s executor_namespace=%s base_url=%s",
            task_id,
            executor_name,
            executor_namespace,
            base_url,
        )
        return base_url.rstrip("/")

    def _get_sandbox_payload(self, task_id: int) -> Optional[dict[str, Any]]:
        sandbox_url = (
            f"{self.executor_manager_url}/executor-manager/sandboxes/{task_id}"
        )

        logger.info(
            "[remote_workspace] querying sandbox task_id=%s url=%s",
            task_id,
            sandbox_url,
        )
        try:
            with httpx.Client(timeout=self.request_timeout) as client:
                response = client.get(sandbox_url)
        except Exception as exc:
            logger.warning(
                "[remote_workspace] sandbox query failed task_id=%s url=%s error=%s",
                task_id,
                sandbox_url,
                exc,
            )
            return None

        if response.status_code != 200:
            logger.info(
                "[remote_workspace] sandbox query non_200 task_id=%s url=%s status_code=%s body_preview=%s",
                task_id,
                sandbox_url,
                response.status_code,
                self._to_log_preview(response.text),
            )
            return None
        if not response.content:
            logger.warning(
                "[remote_workspace] sandbox query empty body task_id=%s url=%s",
                task_id,
                sandbox_url,
            )
            return None

        try:
            payload = response.json()
        except ValueError as exc:
            logger.warning(
                "[remote_workspace] sandbox query invalid json task_id=%s url=%s error=%s body_preview=%s",
                task_id,
                sandbox_url,
                exc,
                self._to_log_preview(response.text),
            )
            return None
        return payload if isinstance(payload, dict) else None

    def _is_sandbox_available(self, sandbox_payload: Optional[dict[str, Any]]) -> bool:
        if not sandbox_payload:
            return False

        status = str(sandbox_payload.get("status", "")).lower()
        base_url = sandbox_payload.get("base_url")
        return bool(status == SANDBOX_RUNNING_STATUS and base_url)

    def _resolve_root_path(
        self, task_id: int, sandbox_payload: Optional[dict[str, Any]]
    ) -> str:
        if self._is_sandbox_available(sandbox_payload):
            return SANDBOX_HOME_ROOT
        return _build_task_workspace_root(task_id)

    def _get_executor_payload(
        self,
        executor_name: str,
        executor_namespace: Optional[str] = None,
    ) -> Optional[dict[str, Any]]:
        address_url = f"{self.executor_manager_url}/executor-manager/executor/address"
        logger.info(
            "[remote_workspace] querying executor address executor_name=%s executor_namespace=%s url=%s",
            executor_name,
            executor_namespace,
            address_url,
        )
        try:
            with httpx.Client(timeout=self.request_timeout) as client:
                params = {"executor_name": executor_name}
                if executor_namespace is not None:
                    params["executor_namespace"] = executor_namespace
                response = client.get(
                    address_url,
                    params=params,
                )
        except Exception as exc:
            logger.warning(
                "[remote_workspace] executor address query failed executor_name=%s executor_namespace=%s url=%s error=%s",
                executor_name,
                executor_namespace,
                address_url,
                exc,
            )
            return None

        if response.status_code != 200:
            logger.info(
                "[remote_workspace] executor address query non_200 executor_name=%s executor_namespace=%s status_code=%s body_preview=%s",
                executor_name,
                executor_namespace,
                response.status_code,
                self._to_log_preview(response.text),
            )
            return None
        if not response.content:
            logger.warning(
                "[remote_workspace] executor address query empty body executor_name=%s executor_namespace=%s",
                executor_name,
                executor_namespace,
            )
            return None

        try:
            payload = response.json()
        except ValueError as exc:
            logger.warning(
                "[remote_workspace] executor address query invalid json executor_name=%s executor_namespace=%s error=%s body_preview=%s",
                executor_name,
                executor_namespace,
                exc,
                self._to_log_preview(response.text),
            )
            return None
        return payload if isinstance(payload, dict) else None

    def _ensure_sandbox_available(
        self,
        db: Session,
        task_id: int,
        user_id: int,
    ) -> Optional[str]:
        task_detail = self._get_task_detail(db=db, task_id=task_id, user_id=user_id)
        executor_name = self._get_connected_executor_name(task_detail)
        base_url = self._resolve_workspace_base_url(
            task_id=task_id,
            task_detail=task_detail,
        )
        if not base_url:
            logger.info(
                "[remote_workspace] unavailable task_id=%s user_id=%s reason=no_runtime_base_url",
                task_id,
                user_id,
            )
            raise HTTPException(
                status_code=409, detail="Remote workspace is unavailable"
            )

        if executor_name:
            logger.info(
                "[remote_workspace] resolved executor binding task_id=%s user_id=%s executor_name=%s base_url=%s",
                task_id,
                user_id,
                executor_name,
                base_url,
            )
        else:
            logger.info(
                "[remote_workspace] resolved sandbox runtime without executor binding task_id=%s user_id=%s base_url=%s",
                task_id,
                user_id,
                base_url,
            )
        return executor_name

    def _list_directory_via_sandbox(
        self,
        base_url: str,
        path: str,
    ) -> list[dict[str, Any]]:
        list_dir_url = f"{base_url}/filesystem.Filesystem/ListDir"
        logger.info(
            "[remote_workspace] list_dir request via sandbox url=%s path=%s",
            list_dir_url,
            path,
        )

        try:
            with httpx.Client(timeout=self.request_timeout) as client:
                response = client.post(
                    list_dir_url,
                    content=json.dumps({"path": path, "depth": 1}),
                    headers={
                        "Content-Type": "application/json",
                        "Connect-Protocol-Version": "1",
                    },
                )
        except Exception as exc:
            logger.warning(
                "[remote_workspace] sandbox list_dir request failed url=%s path=%s error=%s",
                list_dir_url,
                path,
                exc,
            )
            raise HTTPException(
                status_code=503,
                detail="Failed to query remote workspace",
            ) from exc

        if response.status_code == 404:
            logger.info(
                "[remote_workspace] sandbox list_dir path not found url=%s path=%s",
                list_dir_url,
                path,
            )
            raise HTTPException(status_code=404, detail="Path not found")
        if response.status_code >= 400:
            logger.warning(
                "[remote_workspace] sandbox list_dir upstream error url=%s path=%s status_code=%s body_preview=%s",
                list_dir_url,
                path,
                response.status_code,
                self._to_log_preview(response.text),
            )
            raise HTTPException(status_code=502, detail="Remote workspace list failed")

        try:
            payload = response.json()
        except ValueError as exc:
            logger.warning(
                "[remote_workspace] sandbox list_dir invalid json url=%s path=%s error=%s body_preview=%s",
                list_dir_url,
                path,
                exc,
                self._to_log_preview(response.text),
            )
            raise HTTPException(
                status_code=502, detail="Invalid remote workspace response"
            ) from exc

        raw_entries = payload.get("entries") if isinstance(payload, dict) else None
        if not isinstance(raw_entries, list):
            return []

        entries: list[dict[str, Any]] = []
        for item in raw_entries:
            if not isinstance(item, dict):
                continue
            entry_path = str(item.get("path", path))
            entry_type = str(item.get("type", ""))
            entries.append(
                {
                    "name": str(item.get("name") or posixpath.basename(entry_path)),
                    "path": entry_path,
                    "is_directory": entry_type == "FILE_TYPE_DIRECTORY",
                    "size": item.get("size", 0),
                    "modified_at": item.get("modified_time"),
                }
            )

        return entries

    def _download_file_via_sandbox(
        self,
        base_url: str,
        path: str,
    ) -> tuple[bytes, Optional[str]]:
        file_url = f"{base_url}/files"
        logger.info(
            "[remote_workspace] file request via sandbox url=%s path=%s",
            file_url,
            path,
        )

        try:
            with httpx.Client(timeout=self.request_timeout) as client:
                response = client.get(
                    file_url,
                    params={"path": path},
                )
        except Exception as exc:
            logger.warning(
                "[remote_workspace] sandbox file request failed url=%s path=%s error=%s",
                file_url,
                path,
                exc,
            )
            raise HTTPException(
                status_code=503,
                detail="Failed to fetch remote file",
            ) from exc

        if response.status_code == 404:
            logger.info(
                "[remote_workspace] sandbox file path not found url=%s path=%s",
                file_url,
                path,
            )
            raise HTTPException(status_code=404, detail="File not found")
        if response.status_code >= 400:
            logger.warning(
                "[remote_workspace] sandbox file upstream error url=%s path=%s status_code=%s body_preview=%s",
                file_url,
                path,
                response.status_code,
                self._to_log_preview(response.text),
            )
            raise HTTPException(status_code=502, detail="Remote file request failed")

        return response.content, response.headers.get("content-type")

    def _list_directory(
        self,
        task_id: int,
        executor_name: Optional[str],
        path: str,
    ) -> list[dict[str, Any]]:
        list_dir_url = (
            f"{self.executor_manager_url}/executor-manager/executor/workspace/tree"
        )
        logger.info(
            "[remote_workspace] list_dir request via manager url=%s task_id=%s executor_name=%s path=%s",
            list_dir_url,
            task_id,
            executor_name,
            path,
        )

        params: dict[str, Any] = {
            "task_id": task_id,
            "path": path,
        }
        if executor_name:
            params["executor_name"] = executor_name

        try:
            with httpx.Client(timeout=self.request_timeout) as client:
                response = client.get(
                    list_dir_url,
                    params=params,
                )
        except Exception as exc:
            logger.warning(
                "[remote_workspace] list_dir request failed url=%s path=%s error=%s",
                list_dir_url,
                path,
                exc,
            )
            raise HTTPException(
                status_code=503,
                detail="Failed to query remote workspace",
            ) from exc

        if response.status_code == 404:
            logger.info(
                "[remote_workspace] list_dir path not found url=%s path=%s",
                list_dir_url,
                path,
            )
            raise HTTPException(status_code=404, detail="Path not found")
        if response.status_code >= 400:
            logger.warning(
                "[remote_workspace] list_dir upstream error url=%s path=%s status_code=%s body_preview=%s",
                list_dir_url,
                path,
                response.status_code,
                self._to_log_preview(response.text),
            )
            raise HTTPException(status_code=502, detail="Remote workspace list failed")

        try:
            payload = response.json()
        except ValueError as exc:
            logger.warning(
                "[remote_workspace] list_dir invalid json url=%s path=%s error=%s body_preview=%s",
                list_dir_url,
                path,
                exc,
                self._to_log_preview(response.text),
            )
            raise HTTPException(
                status_code=502, detail="Invalid remote workspace response"
            ) from exc

        return (
            [item for item in payload if isinstance(item, dict)]
            if isinstance(payload, list)
            else []
        )

    def _download_file(
        self, task_id: int, executor_name: Optional[str], path: str
    ) -> tuple[bytes, Optional[str]]:
        file_url = (
            f"{self.executor_manager_url}/executor-manager/executor/workspace/file"
        )
        logger.info(
            "[remote_workspace] file request via manager url=%s task_id=%s executor_name=%s path=%s",
            file_url,
            task_id,
            executor_name,
            path,
        )

        params: dict[str, Any] = {
            "task_id": task_id,
            "path": path,
        }
        if executor_name:
            params["executor_name"] = executor_name

        try:
            with httpx.Client(timeout=self.request_timeout) as client:
                response = client.get(
                    file_url,
                    params=params,
                )
        except Exception as exc:
            logger.warning(
                "[remote_workspace] file request failed url=%s path=%s error=%s",
                file_url,
                path,
                exc,
            )
            raise HTTPException(
                status_code=503,
                detail="Failed to fetch remote file",
            ) from exc

        if response.status_code == 404:
            logger.info(
                "[remote_workspace] file path not found url=%s path=%s",
                file_url,
                path,
            )
            raise HTTPException(status_code=404, detail="File not found")
        if response.status_code >= 400:
            logger.warning(
                "[remote_workspace] file upstream error url=%s path=%s status_code=%s body_preview=%s",
                file_url,
                path,
                response.status_code,
                self._to_log_preview(response.text),
            )
            raise HTTPException(status_code=502, detail="Remote file request failed")

        return response.content, response.headers.get("content-type")

    def _to_log_preview(self, raw: str) -> str:
        if not raw:
            return ""
        compact = " ".join(raw.split())
        return compact[:LOG_PREVIEW_LIMIT]

    def normalize_and_validate_workspace_path(
        self, path: Optional[str], root_path: str = WORKSPACE_ROOT
    ) -> str:
        normalized_root = root_path.strip() if root_path else WORKSPACE_ROOT
        if not normalized_root:
            normalized_root = WORKSPACE_ROOT
        if not normalized_root.startswith("/"):
            normalized_root = f"/{normalized_root}"
        normalized_root = posixpath.normpath(normalized_root)

        normalized = path.strip() if path else normalized_root
        if not normalized:
            normalized = normalized_root

        if not normalized.startswith("/"):
            normalized = f"/{normalized}"

        normalized = posixpath.normpath(normalized)

        # Compatibility: remap legacy /workspace paths to /home/user in sandbox runtime.
        if normalized_root == SANDBOX_HOME_ROOT and normalized.startswith(
            WORKSPACE_ROOT
        ):
            suffix = normalized[len(WORKSPACE_ROOT) :]
            normalized = posixpath.normpath(f"{SANDBOX_HOME_ROOT}{suffix}")

        # Compatibility: remap legacy /workspace paths to task-scoped workspace root.
        is_task_scoped_workspace_root = normalized_root.startswith(f"{WORKSPACE_ROOT}/")
        already_under_root = normalized == normalized_root or normalized.startswith(
            f"{normalized_root}/"
        )
        if (
            is_task_scoped_workspace_root
            and not already_under_root
            and normalized.startswith(WORKSPACE_ROOT)
        ):
            suffix = normalized[len(WORKSPACE_ROOT) :]
            normalized = posixpath.normpath(f"{normalized_root}{suffix}")

        if normalized == normalized_root:
            return normalized
        if normalized.startswith(f"{normalized_root}/"):
            return normalized

        raise HTTPException(
            status_code=400, detail=f"Path must stay within {normalized_root}"
        )


remote_workspace_service = RemoteWorkspaceService()
