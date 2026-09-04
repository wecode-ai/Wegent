"""Automatic event collectors for workflow loop branches waiting on PR/MRs.

A loop body branch waits for events on the pull request delivered by the
Issue's upstream node (``subject_source=upstream_pull_request``). Events reach
the branch through the project's incoming-hook subscriptions, so the branch
must have a collector watching the delivered MR's repository.

This module creates and reuses those collectors when a branch arms, and
releases them once the Issue workflow reaches its terminal state.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    LoopItemTaskBinding,
    ProjectIncomingHook,
    loop_datetime_is_unset,
    loop_datetime_value_is_unset,
)
from app.schemas.project_incoming_hook import ProjectIncomingHookCreate
from app.services.loop_item_unread import advance_content_revision
from app.services.project_automation_domain import utcnow
from app.services.project_event_sources import normalize_observed_resource
from app.services.project_incoming_hooks import project_incoming_hook_service

logger = logging.getLogger(__name__)

MACHINE_CLI_CREDENTIAL = "machine-cli"
SCOPE_SOURCE = "branch_wait"
COMPLETED_NODE_STATUSES = {"completed", "forced_completed"}


def _branch_nodes(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        node
        for node in nodes
        if node.get("node_type") == "branch"
        and isinstance(node.get("event_wait"), dict)
        and node.get("event_wait", {}).get("source_type") in {"github", "gitlab"}
    ]


def _armed(branch: Mapping[str, Any]) -> bool:
    return branch.get("status") in {"waiting", "reacting"}


def _platform(branch: Mapping[str, Any]) -> str:
    return str(branch["event_wait"].get("source_type") or "github")


def _poll_interval(branch: Mapping[str, Any]) -> int:
    event_wait = branch.get("event_wait") or {}
    interval = int(event_wait.get("poll_interval_seconds") or 300)
    return max(60, min(interval, 86_400))


def _bound_change_request(
    db: Session,
    item: LoopItem,
    platform: str,
) -> dict[str, Any] | None:
    """Return the newest bound PR/MR matching one platform, if any."""

    bindings = (
        db.query(LoopItemTaskBinding)
        .filter(
            LoopItemTaskBinding.loop_item_id == item.id,
            loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
        )
        .all()
    )
    best: dict[str, Any] | None = None
    best_at: str | None = None
    for binding in bindings:
        metadata = (
            binding.metadata_json if isinstance(binding.metadata_json, dict) else {}
        )
        for change_request in metadata.get("change_requests") or []:
            if not isinstance(change_request, dict):
                continue
            if change_request.get("provider") != platform:
                continue
            if not change_request.get("repository") or not change_request.get(
                "instance_url"
            ):
                continue
            bound_at = change_request.get("last_confirmed_at") or change_request.get(
                "bound_at"
            )
            if bound_at is None or best_at is None or str(bound_at) > best_at:
                best = change_request
                best_at = str(bound_at)
    return best


def _collector_resource(
    platform: str, change_request: Mapping[str, Any]
) -> dict[str, Any]:
    instance_url = str(change_request["instance_url"]).rstrip("/")
    repository = str(change_request["repository"]).strip("/")
    return normalize_observed_resource(
        platform,
        {"url": f"{instance_url}/{repository}"},
    )


def _existing_collector(
    db: Session,
    *,
    project_id: str,
    platform: str,
    mode: str,
    resource: Mapping[str, Any],
) -> ProjectIncomingHook | None:
    path = str(resource.get("path") or "").strip().lower()
    instance_url = str(resource.get("instance_url") or "").rstrip("/").lower()
    if not path and not instance_url:
        return None
    hooks = (
        db.query(ProjectIncomingHook)
        .filter(
            ProjectIncomingHook.cloud_project_id == project_id,
            ProjectIncomingHook.source == platform,
            ProjectIncomingHook.status == "active",
            loop_datetime_is_unset(ProjectIncomingHook.deleted_at),
        )
        .all()
    )
    for hook in hooks:
        metadata = project_incoming_hook_service.metadata(hook)
        if metadata.get("collection_mode") != mode:
            continue
        candidate = metadata.get("resource")
        if not isinstance(candidate, dict):
            continue
        if (
            str(candidate.get("path") or "").strip().lower() == path
            and str(candidate.get("instance_url") or "").rstrip("/").lower()
            == instance_url
        ):
            return hook
    return None


def _hook_refs(hook: ProjectIncomingHook) -> dict[str, Any]:
    metadata = project_incoming_hook_service.metadata(hook)
    refs = metadata.get("branch_wait_refs")
    return refs if isinstance(refs, dict) else {}


def _save_hook_refs(
    db: Session,
    hook: ProjectIncomingHook,
    refs: Mapping[str, Any],
) -> None:
    metadata = project_incoming_hook_service.metadata(hook)
    metadata["branch_wait_refs"] = dict(refs)
    hook.metadata_json = metadata
    hook.version += 1
    db.add(hook)


def _create_collector(
    db: Session,
    *,
    project: CloudProject,
    item: LoopItem,
    user_id: int,
    platform: str,
    mode: str,
    resource: Mapping[str, Any],
    poll_interval: int | None,
) -> ProjectIncomingHook:
    values = ProjectIncomingHookCreate(
        name=f"分支事件采集 {item.id}",
        source_type=platform,  # type: ignore[arg-type]
        collection_mode=mode,  # type: ignore[arg-type]
        resource={"url": str(resource.get("url") or "")},
        poll_interval_seconds=poll_interval if mode in {"poll", "hybrid"} else None,
        credential_ref=(MACHINE_CLI_CREDENTIAL if mode in {"poll", "hybrid"} else None),
    )
    hook, _webhook_token = project_incoming_hook_service.create(
        db,
        str(project.id),
        user_id,
        values,
        validate=False,
    )
    metadata = project_incoming_hook_service.metadata(hook)
    metadata["scope"] = {"source": SCOPE_SOURCE}
    metadata["branch_wait_refs"] = {str(item.id): []}
    hook.metadata_json = metadata
    hook.version += 1
    db.add(hook)
    db.flush()
    return hook


def _actor_user_id(db: Session, item: LoopItem) -> int:
    if item.created_by_user_id:
        return int(item.created_by_user_id)
    project = db.get(CloudProject, item.cloud_project_id)
    return int(project.created_by_user_id or 0) if project is not None else 1


def _workflow_nodes(item: LoopItem) -> list[dict[str, Any]] | None:
    metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
    workflow = metadata.get("workflow")
    nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
    return (
        [dict(node) for node in nodes if isinstance(node, dict)]
        if isinstance(nodes, list)
        else None
    )


def ensure_branch_collectors(
    db: Session,
    item: LoopItem,
    *,
    nodes: list[dict[str, Any]] | None = None,
    actor_user_id: int | None = None,
) -> int:
    """Create or reuse collectors for every armed branch of an Issue workflow.

    Returns the number of workflow nodes whose collector metadata changed so
    callers can decide whether the workflow snapshot needs persisting.
    """

    if nodes is None:
        nodes = _workflow_nodes(item)
    if not nodes:
        return 0
    branches = [branch for branch in _branch_nodes(nodes) if _armed(branch)]
    if not branches:
        return 0
    project = db.get(CloudProject, item.cloud_project_id)
    if project is None:
        return 0
    user_id = actor_user_id or _actor_user_id(db, item)
    if not user_id:
        return 0
    changed = 0
    for branch in branches:
        try:
            platform = _platform(branch)
            change_request = _bound_change_request(db, item, platform)
            if change_request is None:
                continue
            collector_id = branch.get("collector_id")
            hook = db.get(ProjectIncomingHook, collector_id) if collector_id else None
            if (
                hook is None
                or hook.status != "active"
                or not loop_datetime_value_is_unset(hook.deleted_at)
            ):
                event_wait = branch.get("event_wait") or {}
                mode = str(event_wait.get("collection_mode") or "poll")
                resource = _collector_resource(platform, change_request)
                hook = _existing_collector(
                    db,
                    project_id=str(project.id),
                    platform=platform,
                    mode=mode,
                    resource=resource,
                )
                if hook is None:
                    hook = _create_collector(
                        db,
                        project=project,
                        item=item,
                        user_id=user_id,
                        platform=platform,
                        mode=mode,
                        resource=resource,
                        poll_interval=_poll_interval(branch),
                    )
                    hook.due_at = utcnow()
            if hook is None:
                continue
            refs = _hook_refs(hook)
            node_refs = refs.get(str(item.id))
            if (
                not isinstance(node_refs, list)
                or str(branch.get("id")) not in node_refs
            ):
                node_refs = list(node_refs) if isinstance(node_refs, list) else []
                node_refs.append(str(branch.get("id")))
                refs[str(item.id)] = node_refs
                _save_hook_refs(db, hook, refs)
            if str(branch.get("collector_id") or "") != str(hook.id):
                branch["collector_id"] = str(hook.id)
                branch["collector_state"] = {
                    "mode": str(
                        (branch.get("event_wait") or {}).get("collection_mode")
                        or "poll"
                    ),
                    "status": (
                        "needs_registration"
                        if str(
                            (branch.get("event_wait") or {}).get("collection_mode")
                            or "poll"
                        )
                        == "webhook"
                        else "active"
                    ),
                    "created_at": utcnow().isoformat(),
                }
                changed += 1
        except HTTPException as exc:
            db.rollback()
            logger.warning(
                "[BranchCollector] ensure skipped item=%s node=%s reason=%s",
                item.id,
                branch.get("id"),
                exc.status_code,
            )
        except Exception:
            db.rollback()
            logger.exception(
                "[BranchCollector] ensure failed item=%s node=%s",
                item.id,
                branch.get("id"),
            )
    if changed:
        logger.info(
            "[BranchCollector] ensured collectors item=%s changed=%s",
            item.id,
            changed,
        )
    return changed


def _workflow_terminal(nodes: list[dict[str, Any]]) -> bool:
    required = [node for node in nodes if node.get("required", True)]
    return bool(required) and all(
        node.get("status") in COMPLETED_NODE_STATUSES for node in required
    )


def release_item_collectors(
    db: Session,
    item: LoopItem,
    *,
    nodes: list[dict[str, Any]] | None = None,
) -> int:
    """Release collectors created for one Issue once its workflow is terminal."""

    if nodes is None:
        nodes = _workflow_nodes(item)
    if not nodes:
        return 0
    collector_ids = {
        str(node.get("collector_id"))
        for node in _branch_nodes(nodes)
        if node.get("collector_id")
    }
    if not collector_ids:
        return 0
    released = 0
    for collector_id in collector_ids:
        hook = db.get(ProjectIncomingHook, collector_id)
        if hook is None or not loop_datetime_value_is_unset(hook.deleted_at):
            continue
        metadata = project_incoming_hook_service.metadata(hook)
        refs = metadata.get("branch_wait_refs")
        refs = refs if isinstance(refs, dict) else {}
        if str(item.id) not in refs:
            continue
        next_refs = {
            ref_item: ref_nodes
            for ref_item, ref_nodes in refs.items()
            if str(ref_item) != str(item.id)
        }
        metadata["branch_wait_refs"] = next_refs
        scope = metadata.get("scope")
        auto_created = isinstance(scope, dict) and scope.get("source") == SCOPE_SOURCE
        if auto_created and not next_refs:
            hook.status = "disabled"
            hook.deleted_at = utcnow()
            hook.metadata_json = metadata
            hook.version += 1
            db.add(hook)
            released += 1
            continue
        hook.metadata_json = metadata
        hook.version += 1
        db.add(hook)
    if released:
        logger.info(
            "[BranchCollector] released collectors item=%s count=%s", item.id, released
        )
    return released


def persist_workflow_nodes(
    db: Session,
    item: LoopItem,
    nodes: list[dict[str, Any]],
) -> None:
    metadata = dict(item.metadata_json or {})
    workflow = metadata.get("workflow")
    workflow = dict(workflow) if isinstance(workflow, dict) else {}
    workflow["version"] = int(workflow.get("version") or 1) + 1
    workflow["nodes"] = nodes
    metadata["workflow"] = workflow
    item.metadata_json = advance_content_revision(metadata)
    item.version += 1
    db.add(item)


def sweep_item_collectors(db: Session, item: LoopItem) -> int:
    """Ensure or release collectors for one Issue based on its workflow state."""

    nodes = _workflow_nodes(item)
    if not nodes:
        return 0
    changed = 0
    terminal = _workflow_terminal(nodes)
    if terminal:
        changed += release_item_collectors(db, item, nodes=nodes)
    else:
        changed += ensure_branch_collectors(db, item, nodes=nodes)
    if changed:
        persist_workflow_nodes(db, item, nodes)
        db.commit()
    return changed
