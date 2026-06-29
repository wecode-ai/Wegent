# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add orphan pod cleanup capabilities to JobService (K8s-specific).

Patches JobService with:
  - cleanup_orphan_pods: scan K8s for old pods with no DB subtask records
  - _cleanup_orphan_pod: delete a single orphan pod by task_id
  - cleanup_stale_task_executor: override to attempt orphan pod deletion
    when no subtask records are found (instead of returning executor_not_found)
"""

import logging
from typing import Any, Dict

import app.services.adapters.executor_job as _executor_job_mod

logger = logging.getLogger(__name__)

_patch_applied = False
_original_cleanup_stale_task_executor = None

try:
    from app.services.adapters.executor_job import JobService
except Exception:
    JobService = None  # type: ignore


async def _cleanup_orphan_pod(
    self,
    *,
    task_id: int,
    inactive_hours: int,
) -> Dict[str, object]:
    """Delete K8s pod(s) for a task that has no DB subtask records."""
    ek_service = _executor_job_mod.executor_kinds_service
    try:
        result = await ek_service.delete_executor_by_task_id_async(task_id)
    except Exception as exc:
        logger.warning(
            "[executor_job] Failed to delete orphan pod task_id=%s error=%s",
            task_id,
            exc,
        )
        return {
            "task_id": task_id,
            "deleted": False,
            "skipped": True,
            "reason": "executor_not_found",
            "executors": [],
        }

    k8s_status = result.get("status")
    deleted_pods = result.get("deleted_pods", [])
    if k8s_status == "success" and deleted_pods:
        logger.info(
            "[executor_job] Deleted orphan pod(s) task_id=%s pods=%s",
            task_id,
            deleted_pods,
        )
        return {
            "task_id": task_id,
            "deleted": True,
            "skipped": False,
            "reason": "pod_deleted",
            "executors": [],
            "deleted_pods": deleted_pods,
        }

    return {
        "task_id": task_id,
        "deleted": False,
        "skipped": True,
        "reason": "executor_not_found",
        "executors": [],
        "k8s_status": k8s_status,
    }


async def cleanup_orphan_pods(
    self,
    db,
    *,
    older_than_hours: int = 48,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """Scan K8s for old pods with no DB subtask records and clean them up.

    Complements cleanup_stale_executors which only handles pods that have
    corresponding subtask rows. This method finds orphan pods — those that
    exist in K8s but have no DB record at all.
    """
    result: Dict[str, Any] = {
        "target": "orphan_pods",
        "older_than_hours": older_than_hours,
        "dry_run": dry_run,
        "total_scanned": 0,
        "deleted": [],
        "skipped": [],
        "failed": [],
    }

    ek_service = _executor_job_mod.executor_kinds_service
    old_task_id_strs = await ek_service.get_old_task_ids_async(older_than_hours)
    result["total_scanned"] = len(old_task_id_strs)

    if not old_task_id_strs:
        logger.info("[executor_job] No old pods found for orphan cleanup")
        return result

    for task_id_str in old_task_id_strs:
        try:
            task_id = int(task_id_str)
        except (ValueError, TypeError):
            logger.warning(
                "[executor_job] Invalid task_id from K8s label: %s", task_id_str
            )
            continue

        subtasks = await self._get_cleanup_subtasks_for_task(db, task_id)
        if subtasks:
            result["skipped"].append(
                {"task_id": task_id, "reason": "has_subtask_records"}
            )
            continue

        if dry_run:
            result["skipped"].append({"task_id": task_id, "reason": "dry_run"})
            continue

        cleanup_result = await self._cleanup_orphan_pod(
            task_id=task_id,
            inactive_hours=older_than_hours,
        )
        if cleanup_result.get("deleted"):
            result["deleted"].append(
                {
                    "task_id": task_id,
                    "deleted_pods": cleanup_result.get("deleted_pods", []),
                }
            )
        elif cleanup_result.get("reason") == "executor_not_found":
            result["skipped"].append({"task_id": task_id, "reason": "pod_already_gone"})
        else:
            result["failed"].append(
                {"task_id": task_id, "reason": cleanup_result.get("reason")}
            )

    logger.info(
        "[executor_job] Orphan pod cleanup complete "
        "scanned=%d deleted=%d skipped=%d failed=%d",
        result["total_scanned"],
        len(result["deleted"]),
        len(result["skipped"]),
        len(result["failed"]),
    )
    return result


async def _cleanup_stale_task_executor_wecode(
    self,
    db,
    *,
    task_id: int,
    inactive_hours: int = 24,
    dry_run: bool = False,
):
    """Override cleanup_stale_task_executor with orphan pod support.

    When no subtask records exist and dry_run is False, attempt to delete
    the orphan K8s pod instead of immediately returning executor_not_found.
    """
    result = await _original_cleanup_stale_task_executor(
        self, db, task_id=task_id, inactive_hours=inactive_hours, dry_run=dry_run
    )
    if result.get("reason") == "executor_not_found" and not dry_run:
        return await self._cleanup_orphan_pod(
            task_id=task_id, inactive_hours=inactive_hours
        )
    return result


def apply_patch():
    """Patch JobService with K8s-specific orphan pod cleanup capabilities."""
    global _patch_applied, _original_cleanup_stale_task_executor

    if _patch_applied:
        return

    if JobService is None:
        logger.warning("[ExecutorJobPatch] JobService unavailable, skipping")
        return

    _original_cleanup_stale_task_executor = JobService.cleanup_stale_task_executor

    JobService._cleanup_orphan_pod = _cleanup_orphan_pod
    JobService.cleanup_orphan_pods = cleanup_orphan_pods
    JobService.cleanup_stale_task_executor = _cleanup_stale_task_executor_wecode

    _patch_applied = True
    logger.info("[ExecutorJobPatch] Applied orphan pod cleanup capabilities")


apply_patch()
