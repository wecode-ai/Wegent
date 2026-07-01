# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Admin-triggered asynchronous device batch actions."""

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Dict, List, Optional

from packaging.version import InvalidVersion, Version
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.db.session import SessionLocal
from app.schemas.device import DeviceStatusEnum
from app.services.device.admin_device_restart import restart_admin_device
from app.services.device.local_provider import local_device_provider

logger = logging.getLogger(__name__)

MIN_AUTO_UPGRADE_VERSION = Version("1.6.5")
DEVICE_BATCH_ACTION_TIMEOUT_SECONDS = 30


@dataclass(frozen=True)
class AdminDeviceBatchTarget:
    """Device identity snapshot used by an async batch action."""

    user_id: int
    device_id: str


@dataclass(frozen=True)
class AdminDeviceBatchOperationResult:
    """Result returned by one batch item operation."""

    success: bool
    message: str


@dataclass
class AdminDeviceBatchItemState:
    """Per-device state inside a batch action."""

    user_id: int
    device_id: str
    status: str = "pending"
    message: str = ""

    def to_dict(self) -> Dict[str, Any]:
        """Convert item state to API-safe data."""
        return {
            "user_id": self.user_id,
            "device_id": self.device_id,
            "status": self.status,
            "message": self.message,
        }


@dataclass
class AdminDeviceBatchState:
    """In-memory state for one admin device batch action."""

    batch_id: str
    action: str
    status: str
    message: str
    items: List[AdminDeviceBatchItemState]
    triggered: int = 0
    failed: int = 0
    skipped: int = 0
    errors: List[str] = field(default_factory=list)

    @property
    def total(self) -> int:
        """Return total devices considered by this batch."""
        return len(self.items)

    def to_start_dict(self) -> Dict[str, Any]:
        """Convert start response to API-safe data."""
        return {
            "success": self.status != "failed",
            "batch_id": self.batch_id,
            "action": self.action,
            "status": self.status,
            "total": self.total,
            "message": self.message,
        }

    def to_status_dict(self) -> Dict[str, Any]:
        """Convert full batch status to API-safe data."""
        return {
            **self.to_start_dict(),
            "triggered": self.triggered,
            "failed": self.failed,
            "skipped": self.skipped,
            "errors": list(self.errors),
            "items": [item.to_dict() for item in self.items],
        }


def get_device_namespace():
    """Return the currently registered local executor socket namespace."""
    from app.api.ws.device_namespace import device_namespace

    return device_namespace


def _get_upgrade_params(force_stop_tasks: bool) -> Dict[str, Any]:
    """Build local executor upgrade command params."""
    return {
        "force": False,
        "auto_confirm": True,
        "verbose": False,
        "force_stop_tasks": force_stop_tasks,
    }


def _is_version_at_least(version: Optional[str], minimum_version: Version) -> bool:
    """Check whether a complete executor version meets the minimum version."""
    if not version:
        return False

    try:
        return Version(version.strip()) >= minimum_version
    except InvalidVersion:
        return False


class AdminDeviceBatchManager:
    """In-memory coordinator for admin-triggered device batch actions."""

    def __init__(self) -> None:
        self._batches: Dict[str, AdminDeviceBatchState] = {}
        self._tasks: set[asyncio.Task] = set()

    def start_cloud_restart(
        self,
        targets: List[AdminDeviceBatchTarget],
        admin_name: str,
    ) -> AdminDeviceBatchState:
        """Start an asynchronous cloud device restart batch."""
        batch = self._create_batch(
            action="cloud_restart",
            targets=targets,
            message=f"Cloud device restart batch started for {len(targets)} device(s)",
        )
        self._schedule(
            self._run_batch(
                batch.batch_id,
                self._run_cloud_restart(batch.batch_id, admin_name),
            )
        )
        return batch

    def start_local_upgrade(
        self,
        targets: List[AdminDeviceBatchTarget],
        force_stop_tasks: bool,
        admin_name: str,
    ) -> AdminDeviceBatchState:
        """Start an asynchronous local device upgrade batch."""
        batch = self._create_batch(
            action="local_upgrade",
            targets=targets,
            message=f"Local device upgrade batch started for {len(targets)} device(s)",
        )
        self._schedule(
            self._run_batch(
                batch.batch_id,
                self._run_local_upgrade(batch.batch_id, force_stop_tasks, admin_name),
            )
        )
        return batch

    def get_batch(self, batch_id: str) -> Optional[AdminDeviceBatchState]:
        """Return a batch by ID."""
        return self._batches.get(batch_id)

    def _reset_for_tests(self) -> None:
        """Clear in-memory state for isolated tests."""
        for task in list(self._tasks):
            task.cancel()
        self._tasks.clear()
        self._batches.clear()

    def _create_batch(
        self,
        action: str,
        targets: List[AdminDeviceBatchTarget],
        message: str,
    ) -> AdminDeviceBatchState:
        batch = AdminDeviceBatchState(
            batch_id=uuid.uuid4().hex,
            action=action,
            status="pending",
            message=message,
            items=[
                AdminDeviceBatchItemState(
                    user_id=target.user_id,
                    device_id=target.device_id,
                    message="Pending",
                )
                for target in targets
            ],
        )
        self._batches[batch.batch_id] = batch
        return batch

    def _schedule(self, coro: Awaitable[None]) -> None:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _run_batch(self, batch_id: str, coro: Awaitable[None]) -> None:
        try:
            await coro
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            batch = self._batches.get(batch_id)
            if batch is None:
                logger.exception(
                    "[Admin Device Batch] Failed before batch state was available"
                )
                return

            failed_count = 0
            for item in batch.items:
                if item.status in {"pending", "running"}:
                    item.status = "failed"
                    item.message = str(exc)
                    failed_count += 1

            batch.failed += failed_count
            batch.status = "failed"
            batch.message = f"{batch.action} failed: {str(exc)}"
            batch.errors.append(str(exc))
            logger.exception(
                "[Admin Device Batch] Failed: batch_id=%s, action=%s",
                batch.batch_id,
                batch.action,
            )

    async def _run_cloud_restart(self, batch_id: str, admin_name: str) -> None:
        batch = self._batches[batch_id]
        batch.status = "running"
        batch.message = "Cloud device restart batch is running"

        with SessionLocal() as db:
            for item in batch.items:
                await self._run_cloud_restart_item(db, batch, item)

        self._finish_batch(batch, admin_name)

    async def _run_cloud_restart_item(
        self,
        db: Session,
        batch: AdminDeviceBatchState,
        item: AdminDeviceBatchItemState,
    ) -> None:
        item.status = "running"
        item.message = "Restarting"

        try:
            result = await asyncio.wait_for(
                restart_admin_device(db, item.user_id, item.device_id),
                timeout=DEVICE_BATCH_ACTION_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            batch.failed += 1
            item.status = "failed"
            item.message = str(exc)
            batch.errors.append(f"{item.device_id}: {str(exc)}")
            return

        if result.success:
            batch.triggered += 1
            item.status = "success"
        else:
            batch.failed += 1
            item.status = "failed"
            batch.errors.append(f"{item.device_id}: {result.message}")
        item.message = result.message

    async def _run_local_upgrade(
        self,
        batch_id: str,
        force_stop_tasks: bool,
        admin_name: str,
    ) -> None:
        batch = self._batches[batch_id]
        batch.status = "running"
        batch.message = "Local device upgrade batch is running"

        online_info_map = await self._get_online_info_map(batch.items)
        device_namespace = get_device_namespace()

        for item in batch.items:
            await self._run_local_upgrade_item(
                batch,
                item,
                online_info_map,
                device_namespace,
                force_stop_tasks,
            )

        self._finish_batch(batch, admin_name)

    async def _get_online_info_map(
        self, items: List[AdminDeviceBatchItemState]
    ) -> Dict[str, Any]:
        keys = [
            local_device_provider.generate_online_key(item.user_id, item.device_id)
            for item in items
        ]
        if not keys:
            return {}
        return await cache_manager.mget(keys)

    async def _run_local_upgrade_item(
        self,
        batch: AdminDeviceBatchState,
        item: AdminDeviceBatchItemState,
        online_info_map: Dict[str, Any],
        device_namespace: Any,
        force_stop_tasks: bool,
    ) -> None:
        item.status = "running"
        item.message = "Checking eligibility"

        redis_key = local_device_provider.generate_online_key(
            item.user_id, item.device_id
        )
        online_info = online_info_map.get(redis_key)
        skip_reason = self._get_local_upgrade_skip_reason(online_info, force_stop_tasks)
        if skip_reason:
            batch.skipped += 1
            item.status = "skipped"
            item.message = skip_reason
            return

        try:
            if device_namespace is None:
                raise RuntimeError("Device namespace is not registered")
            success = await asyncio.wait_for(
                device_namespace.emit_upgrade_command(
                    online_info["socket_id"],
                    _get_upgrade_params(force_stop_tasks),
                ),
                timeout=DEVICE_BATCH_ACTION_TIMEOUT_SECONDS,
            )
        except Exception as exc:
            batch.failed += 1
            item.status = "failed"
            item.message = str(exc)
            batch.errors.append(f"{item.device_id}: {str(exc)}")
            return

        if success:
            batch.triggered += 1
            item.status = "success"
            item.message = "Upgrade command sent"
        else:
            batch.failed += 1
            item.status = "failed"
            item.message = "Failed to send upgrade command"
            batch.errors.append(f"{item.device_id}: failed to send upgrade command")

    def _get_local_upgrade_skip_reason(
        self,
        online_info: Optional[Dict[str, Any]],
        force_stop_tasks: bool,
    ) -> Optional[str]:
        if (
            not online_info
            or online_info.get("status") == DeviceStatusEnum.OFFLINE.value
        ):
            return "Device is offline"
        if not online_info.get("socket_id"):
            return "Device socket information not found"
        if not _is_version_at_least(
            online_info.get("executor_version"), MIN_AUTO_UPGRADE_VERSION
        ):
            return f"Executor version is below {MIN_AUTO_UPGRADE_VERSION}"
        if online_info.get("running_task_ids") and not force_stop_tasks:
            return "Device has running task(s)"
        return None

    def _finish_batch(self, batch: AdminDeviceBatchState, admin_name: str) -> None:
        batch.status = "completed"
        batch.message = (
            f"{batch.action} completed: {batch.triggered} triggered, "
            f"{batch.failed} failed, {batch.skipped} skipped"
        )
        logger.info(
            "[Admin Device Batch] Completed: admin=%s, batch_id=%s, action=%s, "
            "total=%d, triggered=%d, failed=%d, skipped=%d",
            admin_name,
            batch.batch_id,
            batch.action,
            batch.total,
            batch.triggered,
            batch.failed,
            batch.skipped,
        )


admin_device_batch_manager = AdminDeviceBatchManager()
