# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""One transaction boundary for page and MCP project configuration changes."""

import hashlib
import json
import uuid
from collections.abc import Callable, Collection
from copy import deepcopy
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, TypeVar

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.delivery import CloudProject, loop_datetime_value_is_unset
from app.schemas.base_role import BaseRole
from app.schemas.board_views import BoardViews
from app.schemas.cloud_project import CloudProjectBoardConfig, CloudProjectUpdate
from app.schemas.issue_workflow import ProjectWorkflowDefinition
from app.schemas.project_admin import ProjectAdminWriteResult
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.cloud_projects.admin_errors import config_error
from app.services.cloud_projects.admin_receipts import public_write_snapshot
from app.services.cloud_projects.tags import plan_tag_update, require_writable_views
from shared.telemetry.decorators import trace_sync

if TYPE_CHECKING:
    from app.services.cloud_projects.service import CloudProjectService

JOURNAL_KEY = "project_admin_operations"
REVISION_KEY = "project_admin_revision"
PRIVATE_WORKFLOW_FIELDS = {
    "execution_config",
    "execution_config_override",
    "system_prompt",
    "mcp_servers",
    "additional_context",
    "attachments",
    "attachment_ids",
    "project_plugins",
}
MutationResult = TypeVar("MutationResult")


def _public_workflow(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _public_workflow(item)
            for key, item in value.items()
            if key not in PRIVATE_WORKFLOW_FIELDS
        }
    if isinstance(value, list):
        return [_public_workflow(item) for item in value]
    return value


def project_admin_config(
    project: CloudProject, db: Session | None = None, user_id: int | None = None
) -> dict:
    """Return an explicit allowlist, never internal metadata or credentials."""
    metadata = project.metadata_json or {}
    configuration = {
        "name": project.name,
        "description": project.description,
        "tags": list(project.tags),
        "membership_mode": project.membership_mode,
        "default_issue_security": metadata.get("default_issue_security", "open"),
        "card_display": metadata.get("card_display", {}),
        "provider_config": _fingerprint(metadata.get("provider_config", {})),
        "execution_environment": _fingerprint(
            metadata.get("execution_environment", {})
        ),
        "board_config": metadata.get(
            "board_config", CloudProjectBoardConfig().model_dump()
        ),
        "board_views": metadata.get("board_views"),
        "collaboration_policy": metadata.get(
            "collaboration_policy", {"content": "", "revision": 1}
        ),
        "ai_automation": metadata.get("ai_automation", {}),
        "pull_request_automation": {
            key: value
            for key, value in metadata.get("pull_request_automation", {}).items()
            if key in {"enabled", "statuses", "prompt"}
        },
        "workflow_definition": _public_workflow(
            metadata.get("workflow_definition", {})
        ),
    }
    if db is not None and user_id is not None:
        from app.services.cloud_projects.admin_rosters import roster_configuration

        configuration.update(roster_configuration(db, project, user_id))
    return {
        "projectVersion": project.version,
        "revision": metadata.get(REVISION_KEY, 1),
        "configuration": deepcopy(configuration),
    }


def _fingerprint(value: Any) -> dict:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return {
        "configured": bool(value),
        "fingerprint": hashlib.sha256(encoded.encode()).hexdigest(),
    }


def _workflow_update(
    project: CloudProject, values: CloudProjectUpdate
) -> ProjectWorkflowDefinition:
    previous = (project.metadata_json or {}).get("workflow_definition", {})
    supplied = values.workflow_definition.model_dump(exclude_unset=True)
    if "execution_config" not in supplied and "execution_config" in previous:
        supplied["execution_config"] = previous["execution_config"]
    old_nodes = {node["id"]: node for node in previous.get("nodes", [])}
    for node in supplied.get("nodes", []):
        old = old_nodes.get(node["id"], {})
        for field in ("execution_config", "execution_config_override"):
            if field not in node and field in old:
                node[field] = old[field]
    supplied["version"] = previous.get("version", 0) + 1
    return ProjectWorkflowDefinition.model_validate(supplied)


def _validate_references(metadata: dict) -> None:
    config = metadata.get("board_views")
    if config is None:
        return
    require_writable_views(metadata)
    try:
        views = BoardViews.model_validate(config).views
    except (ValidationError, ValueError) as exc:
        raise config_error("invalid_config", str(exc), field="board_views") from exc
    statuses = {
        item["id"] for item in metadata.get("board_config", {}).get("statuses", [])
    }
    if "board_config" not in metadata:
        statuses = {item.id for item in CloudProjectBoardConfig().statuses}
    removed = set(metadata.get("project_removed_tags", []))
    for index, view in enumerate(views):
        for offset, column in enumerate(view.columns):
            field = f"board_views.views.{index}.columns.{offset}.value"
            if column.type == "status" and column.value not in statuses:
                raise config_error(
                    "invalid_config", "Unknown board status", field=field
                )
            if column.type == "tag" and column.value in removed:
                raise config_error(
                    "partial_reference_conflict",
                    "View references a removed tag",
                    field=field,
                )
        if set(view.filter.tags) & removed:
            raise config_error(
                "partial_reference_conflict",
                "View filter references a removed tag",
                field=f"board_views.views.{index}.filter.tags",
            )


def _validate_removed_tags(
    project: CloudProject, candidate: dict, values: CloudProjectUpdate
) -> None:
    removed = set(project.tags) - set(candidate.get("tags", []))
    if (
        values.tag_change is not None
        and values.tag_change.target != values.tag_change.source
    ):
        removed.add(values.tag_change.source)
    schedule = candidate.get("board_config", {}).get("schedule_view", {})
    if schedule.get("tag_filter") in removed:
        raise config_error(
            "partial_reference_conflict",
            "The submitted schedule filter still references the removed tag",
            field="board_config.schedule_view.tag_filter",
        )


def _request_hash(values: CloudProjectUpdate, user_id: int) -> str:
    payload = values.model_dump(
        mode="json",
        exclude={"dry_run", "operation_id", "idempotency_key"},
        exclude_unset=True,
    )
    encoded = json.dumps([user_id, payload], sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def _replay(project: CloudProject, operation_id: str, request_hash: str) -> dict | None:
    entry = (project.metadata_json or {}).get(JOURNAL_KEY, {}).get(operation_id)
    if entry is None:
        return None
    if entry["requestHash"] != request_hash:
        raise config_error(
            "idempotency_conflict",
            "Operation ID was used for another request",
            status_code=409,
        )
    return deepcopy(entry)


def _prepare(
    db: Session, project: CloudProject, values: CloudProjectUpdate, user_id: int
) -> CloudProjectUpdate:
    metadata, items, tags = plan_tag_update(db, project, values)
    candidate = deepcopy(metadata)
    updates = {}
    if tags is not None:
        updates["tags"] = tags
        metadata["tags"] = tags
        candidate["tags"] = tags
    for field in ("board_views", "board_config", "collaboration_policy"):
        if getattr(values, field) is not None:
            candidate[field] = values.model_dump(mode="json")[field]
    if values.collaboration_policy is not None:
        previous = (project.metadata_json or {}).get("collaboration_policy", {})
        updates["collaboration_policy"] = values.collaboration_policy.model_copy(
            update={"revision": previous.get("revision", 1) + 1}
        )
    if values.workflow_definition is not None:
        updates["workflow_definition"] = _workflow_update(project, values)
    if values.board_views is not None or values.board_config is not None:
        require_writable_views(project.metadata_json or {})
        _validate_references(candidate)
    elif values.tag_change is not None or values.tags is not None:
        _validate_references(candidate)
    _validate_removed_tags(project, candidate, values)
    project.metadata_json = metadata
    db.flush()
    from app.schemas.delivery import LoopItemUpdate
    from app.services.loop_items.service import loop_item_service

    for item, item_metadata in items:
        if loop_datetime_value_is_unset(item.deleted_at):
            loop_item_service.update(
                db,
                item.id,
                user_id,
                LoopItemUpdate(version=item.version, tags=item_metadata["tags"]),
                commit=False,
            )
        else:
            item.metadata_json = item_metadata
            item.version += 1
    return values.model_copy(update=updates)


def _result(
    db: Session,
    project: CloudProject,
    before: dict,
    user_id: int,
    operation_id: str,
    dry_run: bool,
) -> dict:
    after = project_admin_config(project, db, user_id)["configuration"]
    diff = [
        {"path": key, "before": before["configuration"].get(key), "after": value}
        for key, value in after.items()
        if value != before["configuration"].get(key)
    ]
    policy_changed = any(
        item["path"] in {"collaboration_policy", "workflow_definition"} for item in diff
    )
    return ProjectAdminWriteResult(
        projectVersion=before["projectVersion"] if dry_run else project.version,
        revision=before["revision"] if dry_run else before["revision"] + 1,
        before=before["configuration"],
        after=after,
        diff=diff,
        actor={"userId": user_id},
        operationId=operation_id,
        dryRun=dry_run,
        appliedAt=None if dry_run else datetime.now(timezone.utc),
        auditId=None if dry_run else str(uuid.uuid4()),
        effectScope="future_issues" if policy_changed else None,
        runningIssueSnapshotRule="preserved" if policy_changed else None,
    ).model_dump(mode="json")


@trace_sync("cloud_projects.update", tracer_name="backend")
def update_project(
    service: "CloudProjectService",
    db: Session,
    project_id: int,
    user_id: int,
    values: CloudProjectUpdate,
    *,
    mutation: Callable[[], None] | None = None,
    revoked_user_ids: Collection[int] = (),
    revoked_agent_ids: Collection[str] = (),
) -> CloudProject:
    """Lock, validate, plan, apply and journal together, or roll everything back."""
    try:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        project = service._lock_project(db, project_id)
        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        project._project_admin_response = None
        operation_id = (
            values.operation_id or values.idempotency_key or str(uuid.uuid4())
        )
        request_hash = _request_hash(values, user_id)
        replay = _replay(project, operation_id, request_hash)
        if replay is not None:
            project._project_admin_result = replay["result"]
            project._project_admin_response = replay["response"]
            return project
        if project.version != values.version:
            raise config_error(
                "version_conflict",
                "Reload the project and retry with its current version",
                field="version",
                status_code=409,
            )
        before = project_admin_config(project, db, user_id)
        planned = _prepare(db, project, values, user_id)
        if mutation is not None:
            mutation()
        elif values.member_changes or values.assistant_roster_changes:
            from app.services.cloud_projects.admin_rosters import apply_roster_updates

            apply_roster_updates(service, db, project, user_id, values)
        service._apply_update(db, project, user_id, planned)
        result = _result(db, project, before, user_id, operation_id, values.dry_run)
        if values.dry_run:
            db.rollback()
        else:
            _commit(
                db,
                project,
                operation_id,
                request_hash,
                result,
                revoked_user_ids={
                    *(change.user_id for change in values.member_changes or []),
                    *revoked_user_ids,
                },
                revoked_agent_ids={
                    *(
                        change.agent_id
                        for change in values.assistant_roster_changes or []
                    ),
                    *revoked_agent_ids,
                },
            )
        project._project_admin_result = result
        return project
    except ValidationError as exc:
        db.rollback()
        raise HTTPException(
            422,
            {
                "reason_code": "invalid_config",
                "message": "Project configuration failed validation",
                "fields": [
                    {"path": list(error["loc"]), "message": error["msg"]}
                    for error in exc.errors()
                ],
            },
        ) from exc
    except HTTPException as exc:
        db.rollback()
        if exc.status_code in {403, 409}:
            if isinstance(exc.detail, dict) and "reason_code" in exc.detail:
                raise
            raise config_error(
                "permission_denied" if exc.status_code == 403 else "version_conflict",
                str(exc.detail),
                status_code=exc.status_code,
            ) from exc
        raise
    except Exception:
        db.rollback()
        raise


def run_configuration_change(
    service: "CloudProjectService",
    db: Session,
    project_id: int,
    user_id: int,
    mutation: Callable[[], MutationResult],
    *,
    revoked_user_ids: Collection[int] = (),
    revoked_agent_ids: Collection[str] = (),
) -> MutationResult:
    """Bring existing page mutations into the same locked audit transaction."""
    results: list[MutationResult] = []
    try:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        project = service._lock_project(db, project_id)

        def apply_mutation() -> None:
            results.append(mutation())

        update_project(
            service,
            db,
            project_id,
            user_id,
            CloudProjectUpdate(version=project.version),
            mutation=apply_mutation,
            revoked_user_ids=revoked_user_ids,
            revoked_agent_ids=revoked_agent_ids,
        )
        return results[0]
    except Exception:
        db.rollback()
        raise


def _commit(
    db: Session,
    project: CloudProject,
    operation_id: str,
    request_hash: str,
    result: dict,
    *,
    revoked_user_ids: Collection[int],
    revoked_agent_ids: Collection[str],
) -> None:
    from app.services.collaboration_revocation import revoke_unauthorized_project_work
    from app.services.loop_item_executions.cancellation import (
        request_execution_cancellations,
    )

    metadata = deepcopy(project.metadata_json or {})
    journal = metadata.setdefault(JOURNAL_KEY, {})
    snapshot = public_write_snapshot(project)
    journal[operation_id] = {
        "requestHash": request_hash,
        "result": result,
        "response": snapshot,
    }
    metadata[REVISION_KEY] = result["revision"]
    project.metadata_json = metadata
    # Journaling is part of this write, not a second configuration timestamp.
    flag_modified(project, "updated_at")
    db.flush()
    pending = []
    for target_user_id in set(revoked_user_ids):
        pending.extend(
            revoke_unauthorized_project_work(
                db, project.id, actor_user_id=target_user_id
            )
        )
    if revoked_agent_ids:
        pending.extend(
            revoke_unauthorized_project_work(
                db, project.id, agent_ids=set(revoked_agent_ids)
            )
        )
    db.commit()
    db.refresh(project)
    project._project_admin_response = snapshot
    request_execution_cancellations(pending)
