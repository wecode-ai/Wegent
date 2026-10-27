"""Refresh and expose authorized, non-secret environment model catalogs."""

import asyncio
import logging

from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.runner_routing import RunnerCatalog
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.device.runtime_route import runtime_device_route_id
from app.services.device.runtime_rpc_service import RuntimeRpcError, runtime_rpc_service
from app.services.runner_routing import (
    catalog,
    project_environment_ids,
    save_catalog,
    visible_environment_ids,
)
from app.services.workspaces.environment_status import execution_environment_statuses
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)


async def _refresh(device: Kind) -> RunnerCatalog:
    result = await runtime_rpc_service.call(
        user_id=device.user_id,
        device_id=runtime_device_route_id(device),
        method="runtime.runner.catalog",
        payload={},
        allow_app_device_catalog_reading=True,
    )
    if result.get("success") is False:
        code = result.get("code")
        raise RuntimeRpcError(
            "Runner model catalog request failed",
            code=(
                code
                if isinstance(code, str) and code
                else "runtime_rpc_invalid_response"
            ),
        )
    return RunnerCatalog.model_validate(result)


@trace_async("runner.catalog", tracer_name="backend")
async def environment_catalog(
    db: Session, user_id: int, project_id: str | None
) -> list[dict]:
    if project_id:
        require_cloud_project_role(db, project_id, user_id)
    ids = visible_environment_ids(db, user_id, project_id)
    devices = db.query(Kind).filter(Kind.id.in_(ids), Kind.is_active.is_(True)).all()
    statuses = await execution_environment_statuses(devices)
    connected = [device for device in devices if statuses[device.id] == "online"]
    results = await asyncio.gather(
        *(_refresh(device) for device in connected), return_exceptions=True
    )
    errors: dict[int, str] = {}
    for device, result in zip(connected, results):
        if isinstance(result, Exception):
            # Keep the last reported catalog for offline queueing, with visible freshness.
            code = (
                result.code
                if isinstance(result, RuntimeRpcError)
                else (
                    "runner_catalog_invalid"
                    if isinstance(result, ValidationError)
                    else "runner_catalog_refresh_failed"
                )
            )
            errors[device.id] = code
            logger.warning(
                "Runner catalog refresh failed: environment_id=%s owner_id=%s "
                "error_code=%s error_type=%s",
                device.id,
                device.user_id,
                code,
                type(result).__name__,
            )
        else:
            save_catalog(db, device, result)
    allowed = project_environment_ids(db, project_id) if project_id else set()
    if project_id:
        from app.services.project_device_access import filter_device_access

        allowed = filter_device_access(db, project_id, user_id, allowed)
    rows = []
    for device in devices:
        spec = (device.json or {}).get("spec") or {}
        owner_id = spec.get("workspaceOwnerId")
        rows.append(
            {
                "id": str(device.id),
                "device_key": runtime_device_route_id(device),
                "name": spec.get("displayName") or device.name,
                "owner_type": "workspace" if owner_id else "user",
                "owner_id": str(owner_id or device.user_id),
                "status": statuses[device.id],
                "project_authorized": device.id in allowed,
                "catalog_error": errors.get(device.id)
                or ", ".join(catalog(device).errors)
                or None,
                "models": [model.model_dump() for model in catalog(device).models],
                "runtimes": catalog(device).runtimes,
            }
        )
    db.commit()
    return rows


@trace_async("runner.queue_diagnostics", tracer_name="backend")
async def annotate_queue(db: Session, rows: list[dict]) -> None:
    """Explain current waiting conditions without changing the persisted intent."""
    from fastapi import HTTPException

    from app.models.loop_item_execution import LoopItemExecution
    from app.schemas.runner_routing import ExecutionPolicy
    from app.services.runner_routing import _candidates, eligible_runner

    pending = {}
    devices_by_id = {}
    for row in rows:
        execution = db.get(LoopItemExecution, row["id"])
        if execution is None or not execution.uses_runner_routing:
            continue
        row["runner_routing"] = execution.runtime_selection
        if execution.status != "queued":
            continue
        snapshot = execution.runtime_selection["runner_routing"]
        try:
            candidates = _candidates(
                db,
                ExecutionPolicy.model_validate(snapshot["execution_policy"]),
                execution.cloud_project_id,
                execution.assigner_user_id,
            )
            candidates = [
                device
                for device in candidates
                if eligible_runner(db, execution, device)
            ]
            if not candidates:
                row["error_message"] = (
                    "RUNNER_CONFIGURATION_CONFLICT: the bound environment is no longer authorized or does not support this model"
                )
                continue
            pending[row["id"]] = candidates
            devices_by_id.update({device.id: device for device in candidates})
        except HTTPException as error:
            row["error_message"] = (
                error.detail.get("message", str(error.detail))
                if isinstance(error.detail, dict)
                else str(error.detail)
            )
    statuses = (
        await execution_environment_statuses(list(devices_by_id.values()))
        if devices_by_id
        else {}
    )
    for row in rows:
        candidates = pending.get(row["id"])
        if candidates:
            row["waiting_runtime_reason"] = (
                "RUNNER_OFFLINE: waiting for the authorized runner to reconnect"
                if all(statuses[device.id] != "online" for device in candidates)
                else "RUNNER_BUSY: waiting for an eligible runner to claim an available slot"
            )
            row["execution_note"] = row["waiting_runtime_reason"]
