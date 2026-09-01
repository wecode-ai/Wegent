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
import time
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


async def _fallback_delete_pod_by_name(
    *,
    task_id: int,
    pod_name: str,
    trigger_reason: str,
) -> Dict[str, object]:
    """Fallback: delete K8s pod by name directly when upstream cleanup left it alive.

    Mirrors shell pipeline step 3 (delete_notfound_pods.sh). Used by both
    _cleanup_stale_orphan_executor (executor_not_found) and
    _cleanup_stale_orphan_sandbox (pod_delete_failed_metadata_cleared).
    """
    logger.info(
        f"+++ [executor_job] Falling back to direct pod delete task_id={task_id} pod_name={pod_name} trigger_reason={trigger_reason}"
    )
    result: Dict[str, object] = {
        "task_id": task_id,
        "pod_name": pod_name,
        "deleted": False,
        "skipped": False,
        "reason": "delete_failed",
    }

    ek_service = _executor_job_mod.executor_kinds_service
    try:
        k8s_result = await ek_service.delete_pod_by_name_async(pod_name)
    except Exception as exc:
        logger.warning(
            f"+++ [executor_job] Failed to delete orphan pod task_id={task_id} pod_name={pod_name} error={exc}"
        )
        return result

    k8s_status = k8s_result.get("status")
    if k8s_status in ("success", "not_found"):
        logger.info(
            f"+++ [executor_job] Deleted orphan pod task_id={task_id} pod_name={pod_name} k8s_status={k8s_status}"
        )
        result["deleted"] = True
        result["reason"] = "pod_deleted"
        return result
    result["k8s_status"] = k8s_status
    return result


async def _cleanup_stale_orphan_executor(
    self,
    *,
    task_id: int,
    pod_name: str,
    inactive_hours: int,
    max_inactive_hours: int,
    db,
) -> Dict[str, object]:
    """Clean up a single orphan pod following the two-step pipeline:

    Step 1: call cleanup_stale_task_executor (matches script cleanup_stale_tasks.sh)
    Step 2: on executor_not_found, delete K8s pod by pod_name directly
            (matches script delete_notfound_pods.sh / kubectl delete pod)

    Once idle past max_inactive_hours the executor is force-deleted even if
    workspace archiving keeps failing, so a broken archive cannot pin pods forever.
    """
    # Step 1: try the normal stale cleanup path (patched version, handles 404).
    # max_inactive_hours forces deletion past the idle window even if archiving fails.
    cleanup_result = await self.cleanup_stale_task_executor(
        db,
        task_id=task_id,
        inactive_hours=inactive_hours,
        max_inactive_hours=max_inactive_hours,
        dry_run=False,
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
    return await _fallback_delete_pod_by_name(
        task_id=task_id,
        pod_name=pod_name,
        trigger_reason=cleanup_result.get("reason", "executor_not_found"),
    )


async def _cleanup_stale_orphan_sandbox(
    self,
    *,
    task_id: int,
    pod_name: str,
    inactive_hours: int,
    max_inactive_hours: int,
    sandbox_payload: Dict[str, Any],
) -> Dict[str, object]:
    """Clean up a single orphan sandbox pod, archiving before deletion.

    When sandbox_payload is provided, validates last_activity_at against
    inactive_hours before proceeding, mirroring _cleanup_stale_sandbox_for_task.

    Once idle past max_inactive_hours the sandbox is deleted even when workspace
    archiving fails (delete_on_archive_failure), so a broken archive cannot pin
    pods forever.
    """
    result: Dict[str, Any] = {
        "task_id": task_id,
        "pod_name": pod_name,
        "deleted": False,
        "skipped": True,
    }

    # sandbox_payload is guaranteed non-None by caller (_cleanup_orphan_pod)
    try:
        last_activity_at = float(sandbox_payload["last_activity_at"])
    except (KeyError, TypeError, ValueError) as exc:
        logger.warning(
            f"+++ [executor_job] Invalid sandbox_payload task_id={task_id} pod_name={pod_name} error={exc}"
        )
        return {**result, "reason": "invalid_sandbox_payload"}

    now_ts = time.time()
    eligible_after = last_activity_at + inactive_hours * 3600
    if now_ts < eligible_after:
        logger.info(
            f"+++ [executor_job] Orphan sandbox not yet stale task_id={task_id} pod_name={pod_name} last_activity_at={last_activity_at} eligible_after={eligible_after}"
        )
        return {**result, "reason": "not_stale"}

    # Once idle past max_inactive_hours, force deletion even when archiving fails so
    # a broken archive cannot pin the pod forever.
    delete_on_archive_failure = now_ts >= last_activity_at + max_inactive_hours * 3600

    ek_service = _executor_job_mod.executor_kinds_service
    try:
        cleanup_result = await ek_service.cleanup_sandbox_by_task_id_async(
            task_id,
            archive_before_delete=True,
            delete_on_archive_failure=delete_on_archive_failure,
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
        # Redis metadata cleared but pod still alive — fallback to direct K8s delete,
        # mirroring shell pipeline step 3 (delete_notfound_pods.sh).
        fallback = await _fallback_delete_pod_by_name(
            task_id=task_id,
            pod_name=pod_name,
            trigger_reason="pod_delete_failed_metadata_cleared",
        )
        result["deleted"] = fallback["deleted"]
        result["skipped"] = fallback["skipped"]
        result["reason"] = fallback["reason"]
        if "k8s_status" in fallback:
            result["k8s_status"] = fallback["k8s_status"]
    else:
        result["reason"] = reason or "sandbox_cleanup_skipped"

    result["archived"] = archived
    return result


async def cleanup_orphan_pods(
    self,
    db,
    *,
    older_than_hours: int = 48,
    inactive_hours: int = 24,
    max_inactive_hours: int = 24 * 7,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """Scan K8s for old pods with no DB subtask records or stale and clean them up.

    Mirrors the pod_delete/ pipeline:
    1. get_old_pods_async: list old direct Pods and warm-pool runtime targets
    2. For each pod with a valid task_id > ORPHAN_POD_MIN_TASK_ID and no DB records:
       - call cleanup_stale_task_executor with inactive_hours (INACTIVE_HOURS=24)
       - if executor_not_found, delete the Pod or owning SandboxClaim by target name
    3. Pods with no task_id label or task_id <= threshold are skipped entirely,
       matching the original scripts' awk '$1+0 > 1000' guard.

    Args:
        older_than_hours: minimum pod age to scan (default 48h = 2 days)
        inactive_hours: idle window passed to cleanup_stale_task_executor and the
            sandbox eligibility gate (default 24h)
        max_inactive_hours: once idle past this, pods are force-deleted even if
            workspace archiving fails (default 7 days)
    """
    logger.info(
        f"+++ [executor_job] Starting orphan pod cleanup older_than_hours={older_than_hours} inactive_hours={inactive_hours} max_inactive_hours={max_inactive_hours} dry_run={dry_run}"
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
    result["stale_warmpools"] = await _cleanup_stale_warmpool_crs(
        ek_service,
        dry_run=dry_run,
    )

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
                inactive_hours=inactive_hours,
                max_inactive_hours=max_inactive_hours,
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


async def _cleanup_stale_warmpool_crs(ek_service, *, dry_run: bool) -> Dict[str, Any]:
    """Reclaim SandboxWarmPool CRs left behind by executor template upgrades.

    Each template upgrade creates a new SandboxWarmPool CR and the old ones are
    never deleted, so the operator keeps their standby pods alive indefinitely.
    Deleting a stale CR releases only its unbound standby pods; task-bound pods
    keep their task-id labels and stay under the regular orphan pod cleanup.
    Failures never block orphan pod cleanup.
    """
    from wecode.config.orphan_pod_config import ORPHAN_WARMPOOL_CR_GRACE_PERIOD_DAYS

    cleanup = getattr(ek_service, "cleanup_stale_warmpools_async", None)
    if cleanup is None:
        return {"status": "skipped", "reason": "unsupported"}
    try:
        result = await cleanup(
            grace_period_days=ORPHAN_WARMPOOL_CR_GRACE_PERIOD_DAYS,
            dry_run=dry_run,
        )
        logger.info(f"+++ [executor_job] Stale warmpool CR cleanup result={result}")
        return result
    except Exception as exc:
        logger.warning(f"+++ [executor_job] Stale warmpool CR cleanup failed: {exc}")
        return {"status": "failed", "error": str(exc)}


def _pod_is_abnormal(pod_info: Dict[str, Any]) -> bool:
    """Return True when an old pod is in an abnormal (non-Running) K8s state.

    ``status`` is the kubectl-style display status surfaced by get_old_pods_async
    (e.g. "Running", "OOMKilled", "Error", "CrashLoopBackOff"). Only "Running" is
    healthy for these long-lived executor/sandbox pods, so anything else on a pod
    old enough to be scanned is treated as abnormal and eligible for force delete.
    Missing/empty status is treated as normal to stay backward-compatible with an
    older executor_manager that does not report status.
    """
    status = (pod_info.get("status") or "").strip()
    return bool(status) and status.lower() != "running"


async def _cleanup_orphan_pod(
    self,
    *,
    pod_info: Dict[str, Any],
    result: Dict[str, Any],
    db,
    inactive_hours: int,
    max_inactive_hours: int,
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

    cleanup_result: Dict[str, Any] = {
        "task_id": task_id,
        "pod_name": pod_name,
        "deleted": False,
        "skipped": False,
    }

    runtime_client = get_executor_runtime_client()
    sandbox_payload, sandbox_error = await runtime_client.get_sandbox(str(task_id))

    # Step 1: run the normal sandbox/executor cleanup. Capture any failure into
    # cleanup_result instead of returning, so the abnormal-pod force delete below
    # still runs even when this step raises.
    try:
        if sandbox_payload is not None:
            cleanup_result = await self._cleanup_stale_orphan_sandbox(
                task_id=task_id,
                pod_name=pod_name,
                inactive_hours=inactive_hours,
                max_inactive_hours=max_inactive_hours,
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
                inactive_hours=inactive_hours,
                max_inactive_hours=max_inactive_hours,
                db=db,
            )
    except Exception as exc:
        logger.error(
            f"+++ [executor_job] Error cleaning orphan pod task_id={task_id} pod_name={pod_name} error={exc}"
        )
        cleanup_result["reason"] = (
            "http_error" if isinstance(exc, HTTPException) else "unexpected_error"
        )
        cleanup_result["error"] = str(exc)
        if isinstance(exc, HTTPException):
            cleanup_result["status_code"] = exc.status_code
            cleanup_result["detail"] = exc.detail

    logger.info(
        f"+++ [executor_job] _cleanup_orphan_pod done task_id={task_id} pod_name={pod_name} cleanup_result={cleanup_result}"
    )

    # Step 2: last resort — if the normal path left the pod alive (skipped as
    # not_stale, or raised) and the pod is in an abnormal state (OOMKilled, Error,
    # CrashLoopBackOff, ...), it is already dead and cannot be archived, so
    # force-delete it by name. Dead pods must never pin resources indefinitely.
    if not cleanup_result.get("deleted") and _pod_is_abnormal(pod_info):
        pod_status = pod_info.get("status")
        logger.info(
            f"+++ [executor_job] Force-deleting abnormal orphan pod task_id={task_id} pod_name={pod_name} status={pod_status}"
        )
        fallback = await _fallback_delete_pod_by_name(
            task_id=task_id,
            pod_name=pod_name,
            trigger_reason=f"abnormal_pod_status({pod_status})",
        )
        if fallback["deleted"]:
            cleanup_result["deleted"] = True
            cleanup_result["skipped"] = False
            cleanup_result["reason"] = "abnormal_pod_force_deleted"

    _append_pod_result(result, cleanup_result, task_id=task_id)


def _append_pod_result(
    result: Dict[str, Any],
    cleanup_result: Dict[str, Any],
    task_id: Optional[int],
) -> None:
    """Route a single pod cleanup result into the aggregated result buckets.

    cleanup_result already carries task_id, pod_name, reason and any diagnostic
    fields, so it is routed as-is rather than rebuilding a new entry.
    """
    if task_id is not None:
        cleanup_result.setdefault("task_id", task_id)

    if cleanup_result.get("deleted"):
        result["deleted"].append(cleanup_result)
    elif cleanup_result.get("skipped"):
        result["skipped"].append(cleanup_result)
    else:
        result["failed"].append(cleanup_result)


async def _cleanup_stale_task_executor_wecode(
    self,
    db,
    *,
    task_id: int,
    inactive_hours: int = 24,
    max_inactive_hours: int = 24 * 7,
    dry_run: bool = False,
):
    """Override cleanup_stale_task_executor with orphan pod support.

    When no subtask records exist and dry_run is False, attempt to delete
    the orphan K8s pod by task_id label instead of returning executor_not_found.
    """
    logger.info(
        f"+++ [executor_job] cleanup_stale_task_executor_wecode task_id={task_id} inactive_hours={inactive_hours} max_inactive_hours={max_inactive_hours} dry_run={dry_run}"
    )
    try:
        result = await _original_cleanup_stale_task_executor(
            self,
            db,
            task_id=task_id,
            inactive_hours=inactive_hours,
            max_inactive_hours=max_inactive_hours,
            dry_run=dry_run,
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
