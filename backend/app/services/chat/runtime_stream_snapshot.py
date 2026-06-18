# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve active stream snapshots from executor runtime cache or Redis."""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

from app.core.config import settings
from app.core.socketio import get_sio
from app.services.device_service import device_service

logger = logging.getLogger(__name__)

LOCAL_EXECUTOR_PREFIX = "device-"
LOCAL_EXECUTOR_NAMESPACE_PREFIX = "user-"
RUNTIME_CACHE_RPC_TIMEOUT_SECONDS = 3
EXECUTOR_HTTP_TIMEOUT_SECONDS = 3


class RuntimeStreamSnapshotService:
    """Read and clean up runtime stream snapshots with Redis fallback."""

    async def get_snapshot(
        self,
        *,
        task_id: int,
        subtask_id: int,
        streaming_info: Optional[dict[str, Any]] = None,
        executor_name: Optional[str] = None,
        executor_namespace: Optional[str] = None,
        runtime_cache: Optional[dict[str, Any]] = None,
        finalize_redis_blocks: bool = False,
    ) -> dict[str, Any]:
        """Return the best available stream snapshot."""

        resolved_runtime_cache = self._resolve_runtime_cache(
            runtime_cache,
            streaming_info,
        )
        resolved_executor_name = executor_name or self._read_str(
            streaming_info,
            "executor_name",
        )
        resolved_executor_namespace = executor_namespace or self._read_str(
            streaming_info,
            "executor_namespace",
        )

        if self._runtime_cache_enabled(resolved_runtime_cache):
            snapshot = await self._get_executor_snapshot(
                subtask_id=subtask_id,
                executor_name=resolved_executor_name,
                executor_namespace=resolved_executor_namespace,
            )
            if snapshot is not None:
                return self._normalize_snapshot(snapshot, task_id, subtask_id)

        return await self._get_redis_snapshot(
            task_id=task_id,
            subtask_id=subtask_id,
            finalize_blocks=finalize_redis_blocks,
        )

    async def cleanup_snapshot(
        self,
        *,
        subtask_id: int,
        task_id: Optional[int] = None,
        executor_name: Optional[str] = None,
        executor_namespace: Optional[str] = None,
        runtime_cache: Optional[dict[str, Any]] = None,
    ) -> None:
        """Clean up executor runtime cache and Redis streaming state."""

        if self._runtime_cache_enabled(runtime_cache):
            await self._cleanup_executor_snapshot(
                subtask_id=subtask_id,
                executor_name=executor_name,
                executor_namespace=executor_namespace,
            )

        import app.services.chat.storage as chat_storage

        await chat_storage.session_manager.cleanup_streaming_state(
            subtask_id,
            task_id=task_id,
        )

    async def _get_redis_snapshot(
        self,
        *,
        task_id: int,
        subtask_id: int,
        finalize_blocks: bool,
    ) -> dict[str, Any]:
        import app.services.chat.storage as chat_storage

        if finalize_blocks:
            content = await chat_storage.session_manager.get_accumulated_content(
                subtask_id
            )
            blocks = await chat_storage.session_manager.finalize_and_get_blocks(
                subtask_id
            )
        else:
            content = await chat_storage.session_manager.get_streaming_content(
                subtask_id
            )
            blocks = await chat_storage.session_manager.get_blocks(subtask_id)
        get_context_metrics = getattr(
            chat_storage.session_manager, "get_context_metrics", None
        )
        context_metrics = (
            await get_context_metrics(subtask_id)
            if callable(get_context_metrics)
            else None
        )
        if not isinstance(content, str):
            content = ""
        if not isinstance(context_metrics, dict):
            context_metrics = None
        return {
            "task_id": task_id,
            "subtask_id": subtask_id,
            "content": content or "",
            "blocks": blocks or [],
            "context_metrics": context_metrics,
            "offset": len(content or ""),
            "source": "redis",
        }

    async def _get_executor_snapshot(
        self,
        *,
        subtask_id: int,
        executor_name: Optional[str],
        executor_namespace: Optional[str],
    ) -> Optional[dict[str, Any]]:
        if not executor_name:
            return None

        if executor_name.startswith(LOCAL_EXECUTOR_PREFIX):
            return await self._get_local_executor_snapshot(
                subtask_id=subtask_id,
                executor_name=executor_name,
                executor_namespace=executor_namespace,
            )

        return await self._get_docker_executor_snapshot(
            subtask_id=subtask_id,
            executor_name=executor_name,
            executor_namespace=executor_namespace,
        )

    async def _cleanup_executor_snapshot(
        self,
        *,
        subtask_id: int,
        executor_name: Optional[str],
        executor_namespace: Optional[str],
    ) -> None:
        if not executor_name:
            return

        try:
            if executor_name.startswith(LOCAL_EXECUTOR_PREFIX):
                await self._cleanup_local_executor_snapshot(
                    subtask_id=subtask_id,
                    executor_name=executor_name,
                    executor_namespace=executor_namespace,
                )
                return
            await self._cleanup_docker_executor_snapshot(
                subtask_id=subtask_id,
                executor_name=executor_name,
                executor_namespace=executor_namespace,
            )
        except Exception as exc:
            logger.warning(
                "[RuntimeStreamSnapshot] Executor snapshot cleanup failed: "
                "subtask_id=%s executor=%s namespace=%s error=%s",
                subtask_id,
                executor_name,
                executor_namespace,
                exc,
            )

    async def _get_local_executor_snapshot(
        self,
        *,
        subtask_id: int,
        executor_name: str,
        executor_namespace: Optional[str],
    ) -> Optional[dict[str, Any]]:
        user_id = self._parse_user_id(executor_namespace)
        device_id = executor_name.removeprefix(LOCAL_EXECUTOR_PREFIX)
        if user_id is None or not device_id:
            return None

        online_info = await device_service.get_device_online_info(user_id, device_id)
        socket_id = online_info.get("socket_id") if online_info else None
        if not socket_id:
            return None

        sio = get_sio()
        try:
            response = await sio.call(
                "runtime_cache:get_snapshot",
                {"subtask_id": subtask_id},
                to=socket_id,
                namespace="/local-executor",
                timeout=RUNTIME_CACHE_RPC_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            logger.warning(
                "[RuntimeStreamSnapshot] Local runtime cache read failed: "
                "subtask_id=%s user_id=%s device_id=%s error=%s",
                subtask_id,
                user_id,
                device_id,
                exc,
            )
            return None

        if not isinstance(response, dict) or not response.get("success"):
            return None
        snapshot = response.get("snapshot")
        return snapshot if isinstance(snapshot, dict) else None

    async def _cleanup_local_executor_snapshot(
        self,
        *,
        subtask_id: int,
        executor_name: str,
        executor_namespace: Optional[str],
    ) -> None:
        user_id = self._parse_user_id(executor_namespace)
        device_id = executor_name.removeprefix(LOCAL_EXECUTOR_PREFIX)
        if user_id is None or not device_id:
            return

        online_info = await device_service.get_device_online_info(user_id, device_id)
        socket_id = online_info.get("socket_id") if online_info else None
        if not socket_id:
            return

        sio = get_sio()
        await sio.call(
            "runtime_cache:cleanup",
            {"subtask_id": subtask_id},
            to=socket_id,
            namespace="/local-executor",
            timeout=RUNTIME_CACHE_RPC_TIMEOUT_SECONDS,
        )

    async def _get_docker_executor_snapshot(
        self,
        *,
        subtask_id: int,
        executor_name: str,
        executor_namespace: Optional[str],
    ) -> Optional[dict[str, Any]]:
        base_url = await self._resolve_docker_executor_base_url(
            executor_name,
            executor_namespace,
        )
        if not base_url:
            return None

        url = f"{base_url.rstrip('/')}/api/runtime-cache/subtasks/{subtask_id}"
        try:
            async with httpx.AsyncClient(
                timeout=EXECUTOR_HTTP_TIMEOUT_SECONDS
            ) as client:
                response = await client.get(url)
        except Exception as exc:
            logger.warning(
                "[RuntimeStreamSnapshot] Docker runtime cache read failed: "
                "subtask_id=%s executor=%s namespace=%s error=%s",
                subtask_id,
                executor_name,
                executor_namespace,
                exc,
            )
            return None

        if response.status_code == 404:
            return None
        if response.status_code != 200:
            logger.warning(
                "[RuntimeStreamSnapshot] Docker runtime cache read non-200: "
                "subtask_id=%s status=%s body=%s",
                subtask_id,
                response.status_code,
                response.text[:300],
            )
            return None

        payload = response.json()
        snapshot = payload.get("snapshot") if isinstance(payload, dict) else None
        return snapshot if isinstance(snapshot, dict) else None

    async def _cleanup_docker_executor_snapshot(
        self,
        *,
        subtask_id: int,
        executor_name: str,
        executor_namespace: Optional[str],
    ) -> None:
        base_url = await self._resolve_docker_executor_base_url(
            executor_name,
            executor_namespace,
        )
        if not base_url:
            return

        url = f"{base_url.rstrip('/')}/api/runtime-cache/subtasks/{subtask_id}"
        async with httpx.AsyncClient(timeout=EXECUTOR_HTTP_TIMEOUT_SECONDS) as client:
            await client.delete(url)

    async def _resolve_docker_executor_base_url(
        self,
        executor_name: str,
        executor_namespace: Optional[str],
    ) -> Optional[str]:
        url = f"{settings.EXECUTOR_MANAGER_URL.rstrip('/')}/executor-manager/executor/address"
        params: dict[str, Any] = {"executor_name": executor_name}
        if executor_namespace is not None:
            params["executor_namespace"] = executor_namespace

        try:
            async with httpx.AsyncClient(
                timeout=EXECUTOR_HTTP_TIMEOUT_SECONDS
            ) as client:
                response = await client.get(url, params=params)
        except Exception as exc:
            logger.warning(
                "[RuntimeStreamSnapshot] Executor address lookup failed: "
                "executor=%s namespace=%s error=%s",
                executor_name,
                executor_namespace,
                exc,
            )
            return None

        if response.status_code != 200:
            return None
        payload = response.json()
        if not isinstance(payload, dict) or payload.get("status") != "success":
            return None
        base_url = payload.get("base_url")
        return base_url if isinstance(base_url, str) and base_url else None

    @staticmethod
    def _normalize_snapshot(
        snapshot: dict[str, Any],
        task_id: int,
        subtask_id: int,
    ) -> dict[str, Any]:
        content = snapshot.get("content")
        if not isinstance(content, str):
            content = ""
        blocks = snapshot.get("blocks")
        if not isinstance(blocks, list):
            blocks = []
        context_metrics = snapshot.get("context_metrics")
        if not isinstance(context_metrics, dict):
            context_metrics = None
        return {
            "task_id": snapshot.get("task_id") or task_id,
            "subtask_id": snapshot.get("subtask_id") or subtask_id,
            "content": content,
            "blocks": [block for block in blocks if isinstance(block, dict)],
            "context_metrics": context_metrics,
            "offset": snapshot.get("offset") or len(content),
            "started_at": snapshot.get("started_at"),
            "last_activity_at": snapshot.get("last_activity_at"),
            "terminal": bool(snapshot.get("terminal")),
            "source": snapshot.get("source") or "executor",
            "version": snapshot.get("version"),
        }

    @staticmethod
    def _resolve_runtime_cache(
        runtime_cache: Optional[dict[str, Any]],
        streaming_info: Optional[dict[str, Any]],
    ) -> Optional[dict[str, Any]]:
        if isinstance(runtime_cache, dict):
            return runtime_cache
        if not isinstance(streaming_info, dict):
            return None
        candidate = streaming_info.get("runtime_cache")
        return candidate if isinstance(candidate, dict) else None

    @staticmethod
    def _runtime_cache_enabled(runtime_cache: Optional[dict[str, Any]]) -> bool:
        return bool(isinstance(runtime_cache, dict) and runtime_cache.get("enabled"))

    @staticmethod
    def _read_str(payload: Optional[dict[str, Any]], key: str) -> Optional[str]:
        if not isinstance(payload, dict):
            return None
        value = payload.get(key)
        return value if isinstance(value, str) and value else None

    @staticmethod
    def _parse_user_id(executor_namespace: Optional[str]) -> Optional[int]:
        if not executor_namespace:
            return None
        raw = executor_namespace
        if raw.startswith(LOCAL_EXECUTOR_NAMESPACE_PREFIX):
            raw = raw.removeprefix(LOCAL_EXECUTOR_NAMESPACE_PREFIX)
        try:
            return int(raw)
        except (TypeError, ValueError):
            return None


runtime_stream_snapshot_service = RuntimeStreamSnapshotService()
