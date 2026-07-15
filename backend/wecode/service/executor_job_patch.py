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


async def _cleanup_orphan_pod(
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
            "+++ [executor_job] Orphan pod cleaned via stale executor cleanup task_id=%s pod_name=%s",
            task_id,
            pod_name,
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
        "+++ [executor_job] Falling back to direct pod delete task_id=%s pod_name=%s cleanup_result=%s",
        task_id,
        pod_name,
        cleanup_result,
    )
    try:
        result = await ek_service.delete_pod_by_name_async(pod_name)
    except Exception as exc:
        logger.warning(
            "+++ [executor_job] Failed to delete orphan pod task_id=%s pod_name=%s error=%s",
            task_id,
            pod_name,
            exc,
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
            "+++ [executor_job] Deleted orphan pod task_id=%s pod_name=%s k8s_status=%s",
            task_id,
            pod_name,
            k8s_status,
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
    Routes to executor_manager's sandbox cleanup-by-task endpoint which
    archives the sandbox workspace (best-effort) before terminating it.
    Archiving succeeds when the sandbox metadata still exists; the pod is
    deleted regardless.
    """
    if sandbox_payload is not None:
        try:
            last_activity_at = float(sandbox_payload["last_activity_at"])
        except (KeyError, TypeError, ValueError):
            logger.warning(
                "+++ [executor_job] Invalid sandbox_payload for task_id=%s, "
                "proceeding without staleness gate",
                task_id,
            )
        else:
            eligible_after = last_activity_at + inactive_hours * 3600
            if datetime.now(timezone.utc).timestamp() < eligible_after:
                logger.info(
                    "+++ [executor_job] Orphan sandbox not yet stale "
                    "task_id=%s pod_name=%s last_activity_at=%s eligible_after=%s",
                    task_id,
                    pod_name,
                    last_activity_at,
                    eligible_after,
                )
                return {
                    "task_id": task_id,
                    "pod_name": pod_name,
                    "deleted": False,
                    "skipped": True,
                    "reason": "not_stale",
                }

    ek_service = _executor_job_mod.executor_kinds_service
    try:
        result = await ek_service.cleanup_sandbox_by_task_id_async(
            task_id, archive_before_delete=True
        )
    except Exception as exc:
        logger.warning(
            "+++ [executor_job] Failed to clean up orphan sandbox "
            "task_id=%s pod_name=%s error=%s",
            task_id,
            pod_name,
            exc,
        )
        return {
            "task_id": task_id,
            "pod_name": pod_name,
            "deleted": False,
            "skipped": False,
            "reason": "sandbox_cleanup_failed",
        }

    deleted = bool(result.get("deleted"))
    redis_cleared = bool(result.get("redis_cleared"))
    archived = result.get("archived", False)
    reason = result.get("reason", "")

    logger.info(
        "+++ [executor_job] Orphan sandbox cleanup task_id=%s pod_name=%s "
        "archived=%s deleted=%s redis_cleared=%s reason=%s",
        task_id,
        pod_name,
        archived,
        deleted,
        redis_cleared,
        reason,
    )

    if deleted:
        skipped = False
    elif redis_cleared:
        # redis_cleared without pod deletion means the pod is still running —
        # treat as failed so it will be retried in the next cleanup cycle
        skipped = False
        reason = "pod_delete_failed_metadata_cleared"
    else:
        skipped = True
        reason = reason or "sandbox_cleanup_skipped"

    return {
        "task_id": task_id,
        "pod_name": pod_name,
        "deleted": deleted,
        "skipped": skipped,
        "reason": reason,
        "archived": archived,
    }


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
        "+++ [executor_job] Starting orphan pod cleanup older_than_hours=%d stale_hours=%d dry_run=%s",
        older_than_hours,
        stale_hours,
        dry_run,
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
        pod_name: str = pod_info.get("pod_name", "")
        task_id_str: Optional[str] = pod_info.get("task_id")

        if not pod_name or not task_id_str:
            logger.warning(
                "+++ [executor_job] Skipping pod pod_name=%s task_id=%s",
                pod_name,
                task_id_str,
            )
            reason = "no_pod_name" if not pod_name else "no_task_id"
            result["skipped"].append(
                {"pod_name": pod_name, "task_id": task_id_str, "reason": reason}
            )
            continue

        try:
            task_id = int(task_id_str)
        except (ValueError, TypeError):
            logger.warning(
                "+++ [executor_job] Invalid task_id pod_name=%s task_id=%s",
                pod_name,
                task_id_str,
            )
            result["skipped"].append(
                {
                    "pod_name": pod_name,
                    "task_id": task_id_str,
                    "reason": "invalid_task_id",
                }
            )
            continue

        # Mirrors delete_notfound_pods.sh: awk '$1+0 > 1000' guard
        if task_id <= ORPHAN_POD_MIN_TASK_ID:
            result["skipped"].append(
                {
                    "task_id": task_id,
                    "pod_name": pod_name,
                    "reason": "task_id_below_threshold",
                }
            )
            continue

        if dry_run:
            result["skipped"].append(
                {"task_id": task_id, "pod_name": pod_name, "reason": "dry_run"}
            )
            continue

        # Sandbox-first routing, mirroring cleanup_stale_runtimes in
        # admin/runtime_cleanup.py: query the sandbox service to decide
        # the cleanup path instead of relying on Pod annotations.
        runtime_client = get_executor_runtime_client()
        try:
            sandbox_payload, sandbox_error = await runtime_client.get_sandbox(
                str(task_id)
            )
        except Exception as exc:
            logger.error(
                "+++ [executor_job] Sandbox lookup raised task_id=%s pod_name=%s error=%s",
                task_id,
                pod_name,
                exc,
            )
            result["failed"].append(
                {
                    "task_id": task_id,
                    "pod_name": pod_name,
                    "reason": "sandbox_lookup_exception",
                    "error": str(exc),
                }
            )
            continue

        if sandbox_error:
            logger.warning(
                "+++ [executor_job] Sandbox lookup error task_id=%s pod_name=%s error=%s",
                task_id,
                pod_name,
                sandbox_error,
            )
            result["failed"].append(
                {
                    "task_id": task_id,
                    "pod_name": pod_name,
                    "reason": "sandbox_lookup_failed",
                    "error": sandbox_error,
                }
            )
            continue

        try:
            if sandbox_payload is not None:
                cleanup_result = await self._cleanup_stale_orphan_sandbox(
                    task_id=task_id,
                    pod_name=pod_name,
                    inactive_hours=stale_hours,
                    sandbox_payload=sandbox_payload,
                )
            else:
                cleanup_result = await self._cleanup_orphan_pod(
                    task_id=task_id,
                    pod_name=pod_name,
                    inactive_hours=stale_hours,
                    db=db,
                )
        except HTTPException as exc:
            logger.error(
                "+++ [executor_job] HTTPException cleaning orphan pod "
                "task_id=%s pod_name=%s status_code=%s detail=%s",
                task_id,
                pod_name,
                exc.status_code,
                exc.detail,
            )
            result["failed"].append(
                {
                    "task_id": task_id,
                    "pod_name": pod_name,
                    "reason": "http_error",
                    "error": str(exc),
                    "status_code": exc.status_code,
                    "detail": exc.detail,
                }
            )
            continue
        except Exception as exc:
            logger.error(
                "+++ [executor_job] Error cleaning orphan pod task_id=%s pod_name=%s error=%s",
                task_id,
                pod_name,
                exc,
            )
            result["failed"].append(
                {
                    "task_id": task_id,
                    "pod_name": pod_name,
                    "reason": "unexpected_error",
                    "error": str(exc),
                }
            )
            continue
        _append_pod_result(result, cleanup_result, task_id=task_id)

    logger.info(
        "+++ [executor_job] Orphan pod cleanup complete "
        "scanned=%d deleted=%d skipped=%d failed=%d",
        result["total_scanned"],
        len(result["deleted"]),
        len(result["skipped"]),
        len(result["failed"]),
    )
    return result


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
        "+++ [executor_job] cleanup_stale_task_executor_wecode task_id=%s inactive_hours=%d dry_run=%s",
        task_id,
        inactive_hours,
        dry_run,
    )
    try:
        result = await _original_cleanup_stale_task_executor(
            self, db, task_id=task_id, inactive_hours=inactive_hours, dry_run=dry_run
        )
    except HTTPException as exc:
        if exc.status_code == 404:
            logger.info(
                "+++ [executor_job] Task not in DB for task_id=%s, treating as executor_not_found",
                task_id,
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
        "+++ [executor_job] cleanup_stale_task_executor_wecode result task_id=%s result=%s",
        task_id,
        result,
    )
    if result.get("reason") == "executor_not_found" and not dry_run:
        ek_service = _executor_job_mod.executor_kinds_service
        try:
            k8s_result = await ek_service.delete_executor_by_task_id_async(task_id)
        except Exception as exc:
            logger.warning(
                "+++ [executor_job] Failed to delete orphan pod by task_id task_id=%s error=%s",
                task_id,
                exc,
            )
            return result
        k8s_status = k8s_result.get("status")
        deleted_pods = k8s_result.get("deleted_pods", [])
        if k8s_result.get("status") == "success" and deleted_pods:
            logger.info(
                "+++ [executor_job] Deleted orphan pod(s) via task_id label task_id=%s pods=%s",
                task_id,
                deleted_pods,
            )
            return {
                "task_id": task_id,
                "deleted": True,
                "skipped": False,
                "reason": "pod_deleted",
                "deleted_pods": deleted_pods,
            }
        logger.info(
            "+++ [executor_job] No pod found by task_id label task_id=%s k8s_status=%s",
            task_id,
            k8s_status,
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

    JobService._cleanup_orphan_pod = _cleanup_orphan_pod
    JobService._cleanup_stale_orphan_sandbox = _cleanup_stale_orphan_sandbox
    JobService.cleanup_orphan_pods = cleanup_orphan_pods
    JobService.cleanup_stale_task_executor = _cleanup_stale_task_executor_wecode

    _patch_applied = True
    logger.info("+++ [ExecutorJobPatch] Applied orphan pod cleanup capabilities")


apply_patch()
