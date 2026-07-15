# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Add orphan pod cleanup capabilities to JobService (K8s-specific).

Patches JobService with:
  - cleanup_orphan_pods: scan K8s for old pods with no DB subtask records
  - _cleanup_orphan_pod: clean up a single orphan pod:
      1. try cleanup_stale_task_executor (matches script step 2)
      2. on executor_not_found, delete K8s pod directly by pod_name (step 3)
  - cleanup_stale_task_executor: override to attempt orphan pod deletion
    when no subtask records are found (instead of returning executor_not_found)
"""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import HTTPException

import app.services.adapters.executor_job as _executor_job_mod
from app.services.execution import get_executor_runtime_client

logger = logging.getLogger(__name__)

_patch_applied = False
_original_cleanup_stale_task_executor = None

try:
    from app.services.adapters.executor_job import JobService
except Exception:
    JobService = None  # type: ignore


async def _cleanup_stale_orphan_executor(
    self,
    *,
    task_id: int,
    pod_name: str,
    inactive_hours: int,
    db,
) -> Dict[str, object]:
    """Clean up a single orphan pod following the two-step pipeline:

    Step 1: call cleanup_stale_task_executor (matches script cleanup_stale_tasks.sh)
    Step 2: on executor_not_found, delete K8s pod by pod_name directly
            (matches script delete_notfound_pods.sh / kubectl delete pod)
    """
    ek_service = _executor_job_mod.executor_kinds_service

    # Step 1: try the normal stale cleanup path (patched version, handles 404)
    cleanup_result = await self.cleanup_stale_task_executor(
        db, task_id=task_id, inactive_hours=inactive_hours, dry_run=False
    )

    if cleanup_result.get("deleted"):
        logger.info(
            f"+++ [executor_job] Orphan pod cleaned via stale executor cleanup task_id={task_id} pod_name={pod_name}"
        )
        return {
            "task_id": task_id,
            "pod_name": pod_name,
            "deleted": True,
            "skipped": False,
            "reason": cleanup_result.get("reason", "deleted"),
        }

    if cleanup_result.get("reason") != "executor_not_found":
        # Skipped for some other reason (not_stale, dry_run, etc.)
        return {
            "task_id": task_id,
            "pod_name": pod_name,
            "deleted": False,
            "skipped": True,
            "reason": cleanup_result.get("reason", "skipped"),
        }

    # Step 2: fallback — delete K8s pod by name directly
    logger.info(
        f"+++ [executor_job] Falling back to direct pod delete task_id={task_id} pod_name={pod_name} cleanup_result={cleanup_result}"
    )
    try:
        result = await ek_service.delete_pod_by_name_async(pod_name)
    except Exception as exc:
        logger.warning(
            f"+++ [executor_job] Failed to delete orphan pod task_id={task_id} pod_name={pod_name} error={exc}"
        )
        return {
            "task_id": task_id,
            "pod_name": pod_name,
            "deleted": False,
            "skipped": False,
            "reason": "delete_failed",
        }

    k8s_status = result.get("status")
    if k8s_status in ("success", "not_found"):
        logger.info(
            f"+++ [executor_job] Deleted orphan pod task_id={task_id} pod_name={pod_name} k8s_status={k8s_status}"
        )
        return {
            "task_id": task_id,
            "pod_name": pod_name,
            "deleted": True,
            "skipped": False,
            "reason": "pod_deleted",
        }

    return {
        "task_id": task_id,
        "pod_name": pod_name,
        "deleted": False,
        "skipped": False,
        "reason": "delete_failed",
        "k8s_status": k8s_status,
    }


async def _cleanup_stale_orphan_sandbox(
    self,
    *,
    task_id: int,
    pod_name: str,
    inactive_hours: int,
    sandbox_payload: Optional[Dict[str, Any]] = None,
) -> Dict[str, object]:
    """Clean up a single orphan sandbox pod, archiving before deletion.

    When sandbox_payload is provided, validates last_activity_at against
    inactive_hours before proceeding, mirroring _cleanup_stale_sandbox_for_task.
    """
    result: Dict[str, Any] = {
        "task_id": task_id,
        "pod_name": pod_name,
        "deleted": False,
        "skipped": True,
    }

    if sandbox_payload is not None:
        try:
            last_activity_at = float(sandbox_payload["last_activity_at"])
        except (KeyError, TypeError, ValueError) as exc:
            logger.warning(
                f"+++ [executor_job] Invalid sandbox_payload task_id={task_id} pod_name={pod_name} error={exc}"
            )
            return {**result, "reason": "invalid_sandbox_payload"}

        eligible_after = last_activity_at + inactive_hours * 3600
        if datetime.now(timezone.utc).timestamp() < eligible_after:
            logger.info(
                f"+++ [executor_job] Orphan sandbox not yet stale task_id={task_id} pod_name={pod_name} last_activity_at={last_activity_at} eligible_after={eligible_after}"
            )
            return {**result, "reason": "not_stale"}

    ek_service = _executor_job_mod.executor_kinds_service
    try:
        cleanup_result = await ek_service.cleanup_sandbox_by_task_id_async(
            task_id, archive_before_delete=True
        )
    except Exception as exc:
        logger.warning(
            f"+++ [executor_job] Failed to clean up orphan sandbox task_id={task_id} pod_name={pod_name} error={exc}"
        )
        return {**result, "skipped": False, "reason": "sandbox_cleanup_failed"}

    deleted = bool(cleanup_result.get("deleted"))
    redis_cleared = bool(cleanup_result.get("redis_cleared"))
    archived = cleanup_result.get("archived", False)
    reason = cleanup_result.get("reason", "")

    logger.info(
        f"+++ [executor_job] Orphan sandbox cleanup task_id={task_id} pod_name={pod_name} archived={archived} deleted={deleted} redis_cleared={redis_cleared} reason={reason}"
    )

    if deleted:
        result["deleted"] = True
        result["skipped"] = False
        result["reason"] = reason or "sandbox_deleted"
    elif redis_cleared:
        result["skipped"] = False
        result["reason"] = "pod_delete_failed_metadata_cleared"
    else:
        result["reason"] = reason or "sandbox_cleanup_skipped"

    result["archived"] = archived
    return result


async def cleanup_orphan_pods(
    self,
    db,
    *,
    older_than_hours: int = 48,
    stale_hours: int = 24,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """Scan K8s for old pods with no DB subtask records or stale and clean them up.

    Mirrors the pod_delete/ pipeline:
    1. get_old_pods_async: list old pods by name pattern (wegent-task|sandbox)
    2. For each pod with a valid task_id > ORPHAN_POD_MIN_TASK_ID and no DB records:
       - call cleanup_stale_task_executor with stale_hours (INACTIVE_HOURS=24)
       - if executor_not_found, delete K8s pod by name directly
    3. Pods with no task_id label or task_id <= threshold are skipped entirely,
       matching the original scripts' awk '$1+0 > 1000' guard.

    Args:
        older_than_hours: minimum pod age to scan (default 48h = 2 days)
        stale_hours: inactive_hours passed to cleanup_stale_task_executor (default 24h)
    """
    from wecode.config.orphan_pod_config import ORPHAN_POD_MIN_TASK_ID

    logger.info(
        f"+++ [executor_job] Starting orphan pod cleanup older_than_hours={older_than_hours} stale_hours={stale_hours} dry_run={dry_run}"
    )
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
    old_pods = await ek_service.get_old_pods_async(older_than_hours)
    result["total_scanned"] = len(old_pods)

    if not old_pods:
        logger.info("+++ [executor_job] No old pods found for orphan cleanup")
        return result

    for pod_info in old_pods:
        try:
            await self._cleanup_orphan_pod(
                pod_info=pod_info,
                result=result,
                db=db,
                stale_hours=stale_hours,
                dry_run=dry_run,
            )
        except Exception as exc:
            logger.error(
                f"+++ [executor_job] _cleanup_orphan_pod raised task_id={pod_info.get('task_id')} pod_name={pod_info.get('pod_name')} error={exc}"
            )
            result["failed"].append(
                {
                    "task_id": pod_info.get("task_id"),
                    "pod_name": pod_info.get("pod_name"),
                    "reason": "unexpected_error",
                    "error": str(exc),
                }
            )

    logger.info(
        f"+++ [executor_job] Orphan pod cleanup complete scanned={result['total_scanned']} deleted={len(result['deleted'])} skipped={len(result['skipped'])} failed={len(result['failed'])}"
    )
    return result


async def _cleanup_orphan_pod(
    self,
    *,
    pod_info: Dict[str, Any],
    result: Dict[str, Any],
    db,
    stale_hours: int,
    dry_run: bool,
) -> None:
    """Validate and clean up a single orphan pod, appending outcome to result."""
    from wecode.config.orphan_pod_config import ORPHAN_POD_MIN_TASK_ID

    pod_name: str = pod_info.get("pod_name", "")
    task_id_str: Optional[str] = pod_info.get("task_id")

    if not pod_name or not task_id_str:
        logger.warning(
            f"+++ [executor_job] Skipping pod pod_name={pod_name} task_id={task_id_str}"
        )
        reason = "no_pod_name" if not pod_name else "no_task_id"
        result["skipped"].append(
            {"pod_name": pod_name, "task_id": task_id_str, "reason": reason}
        )
        return

    try:
        task_id = int(task_id_str)
        if task_id <= ORPHAN_POD_MIN_TASK_ID:
            raise ValueError(
                f"task_id {task_id} below threshold {ORPHAN_POD_MIN_TASK_ID}"
            )
    except (ValueError, TypeError) as exc:
        logger.warning(
            f"+++ [executor_job] Invalid task_id pod_name={pod_name} task_id={task_id_str} error={exc}"
        )
        result["skipped"].append(
            {
                "pod_name": pod_name,
                "task_id": task_id_str,
                "reason": f"invalid_task_id({task_id_str})",
            }
        )
        return

    if dry_run:
        result["skipped"].append(
            {"task_id": task_id, "pod_name": pod_name, "reason": "dry_run"}
        )
        return

    runtime_client = get_executor_runtime_client()
    sandbox_payload, sandbox_error = await runtime_client.get_sandbox(str(task_id))

    try:
        if sandbox_payload is not None:
            cleanup_result = await self._cleanup_stale_orphan_sandbox(
                task_id=task_id,
                pod_name=pod_name,
                inactive_hours=stale_hours,
                sandbox_payload=sandbox_payload,
            )
        else:
            if sandbox_error:
                logger.warning(
                    f"+++ [executor_job] Sandbox lookup error, falling back to executor cleanup task_id={task_id} pod_name={pod_name} error={sandbox_error}"
                )
            cleanup_result = await self._cleanup_stale_orphan_executor(
                task_id=task_id,
                pod_name=pod_name,
                inactive_hours=stale_hours,
                db=db,
            )
    except Exception as exc:
        logger.error(
            f"+++ [executor_job] Error cleaning orphan pod task_id={task_id} pod_name={pod_name} error={exc}"
        )
        failed_entry: Dict[str, Any] = {
            "task_id": task_id,
            "pod_name": pod_name,
            "reason": (
                "http_error" if isinstance(exc, HTTPException) else "unexpected_error"
            ),
            "error": str(exc),
        }
        if isinstance(exc, HTTPException):
            failed_entry["status_code"] = exc.status_code
            failed_entry["detail"] = exc.detail
        result["failed"].append(failed_entry)
        return
    _append_pod_result(result, cleanup_result, task_id=task_id)


def _append_pod_result(
    result: Dict[str, Any],
    cleanup_result: Dict[str, object],
    task_id: Optional[int],
) -> None:
    """Append a single pod cleanup result to the aggregated result dict."""
    pod_name = cleanup_result.get("pod_name")
    entry: Dict[str, Any] = {"pod_name": pod_name}
    if task_id is not None:
        entry["task_id"] = task_id

    if cleanup_result.get("deleted"):
        result["deleted"].append(entry)
    elif cleanup_result.get("skipped"):
        entry["reason"] = cleanup_result.get("reason")
        result["skipped"].append(entry)
    else:
        entry["reason"] = cleanup_result.get("reason")
        result["failed"].append(entry)


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
    the orphan K8s pod by task_id label instead of returning executor_not_found.
    """
    logger.info(
        f"+++ [executor_job] cleanup_stale_task_executor_wecode task_id={task_id} inactive_hours={inactive_hours} dry_run={dry_run}"
    )
    try:
        result = await _original_cleanup_stale_task_executor(
            self, db, task_id=task_id, inactive_hours=inactive_hours, dry_run=dry_run
        )
    except HTTPException as exc:
        if exc.status_code == 404:
            logger.info(
                f"+++ [executor_job] Task not in DB for task_id={task_id}, treating as executor_not_found"
            )
            result = {
                "task_id": task_id,
                "deleted": False,
                "skipped": False,
                "reason": "executor_not_found",
            }
        else:
            raise
    logger.info(
        f"+++ [executor_job] cleanup_stale_task_executor_wecode result task_id={task_id} result={result}"
    )
    if result.get("reason") == "executor_not_found" and not dry_run:
        ek_service = _executor_job_mod.executor_kinds_service
        try:
            k8s_result = await ek_service.delete_executor_by_task_id_async(task_id)
        except Exception as exc:
            logger.warning(
                f"+++ [executor_job] Failed to delete orphan pod by task_id task_id={task_id} error={exc}"
            )
            return result
        k8s_status = k8s_result.get("status")
        deleted_pods = k8s_result.get("deleted_pods", [])
        if k8s_result.get("status") == "success" and deleted_pods:
            logger.info(
                f"+++ [executor_job] Deleted orphan pod(s) via task_id label task_id={task_id} pods={deleted_pods}"
            )
            return {
                "task_id": task_id,
                "deleted": True,
                "skipped": False,
                "reason": "pod_deleted",
                "deleted_pods": deleted_pods,
            }
        logger.info(
            f"+++ [executor_job] No pod found by task_id label task_id={task_id} k8s_status={k8s_status}"
        )
    return result


def apply_patch():
    """Patch JobService with K8s-specific orphan pod cleanup capabilities."""
    global _patch_applied, _original_cleanup_stale_task_executor

    if _patch_applied:
        return

    if JobService is None:
        logger.warning("+++ [ExecutorJobPatch] JobService unavailable, skipping")
        return

    _original_cleanup_stale_task_executor = JobService.cleanup_stale_task_executor

    JobService._cleanup_stale_orphan_executor = _cleanup_stale_orphan_executor
    JobService._cleanup_stale_orphan_sandbox = _cleanup_stale_orphan_sandbox
    JobService._cleanup_orphan_pod = _cleanup_orphan_pod
    JobService.cleanup_orphan_pods = cleanup_orphan_pods
    JobService.cleanup_stale_task_executor = _cleanup_stale_task_executor_wecode

    _patch_applied = True
    logger.info("+++ [ExecutorJobPatch] Applied orphan pod cleanup capabilities")


apply_patch()
