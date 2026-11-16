"""Build visible runner choices for configuration and explicit failure recovery."""

from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.services.runner_routing import (
    catalog,
    execution_environment_ids,
    issue_binding,
    runtime_device_route_id,
    visible_environment_ids,
)


def attach_runner_selection(db: Session, error: HTTPException, **kwargs: Any) -> None:
    from app.services.runner_recovery import runner_recovery_available

    recovery = (
        isinstance(error.detail, dict)
        and error.detail.get("error_code") == "ISSUE_RUNNER_CONFLICT"
        and not kwargs.get("automatic")
        and not kwargs.get("session_environment_id")
        and runner_recovery_available(db, kwargs["issue_id"])
    )
    if (
        recovery
        or isinstance(error.detail, dict)
        and error.detail.get("error_code")
        in {
            "RUNNER_SELECTION_REQUIRED",
            "RUNNER_MODEL_REQUIRED",
            "AUTOMATION_RUNNER_REQUIRED",
        }
    ):
        config = kwargs["config"]
        ids = visible_environment_ids(db, kwargs["user_id"], kwargs["project_id"])
        allowed = execution_environment_ids(
            db, kwargs["project_id"], kwargs.get("agent_id")
        )
        devices = (
            db.query(Kind)
            .filter(
                Kind.id.in_(ids),
                Kind.kind == "Device",
                Kind.namespace == "default",
                Kind.is_active.is_(True),
            )
            .all()
        )
        policy = config["execution_policy"]
        bound = issue_binding(db, kwargs["issue_id"])
        if (
            bound
            and not recovery
            and policy["mode"] == "user_select"
            and not kwargs.get("automatic")
        ):
            policy = {"mode": "fixed", "environment_id": bound}
        environments = []
        from app.services.runner_cloud_models import cloud_model_catalog

        for device in devices:
            spec = (device.json or {}).get("spec") or {}
            workspace = spec.get("workspaceOwnerId")
            environments.append(
                {
                    "id": str(device.id),
                    "device_key": runtime_device_route_id(device),
                    "name": spec.get("displayName") or device.name,
                    "owner_type": "workspace" if workspace else "user",
                    "owner_id": str(workspace or device.user_id),
                    "status": "unknown",
                    "project_authorized": device.id in allowed,
                    "models": [model.model_dump() for model in catalog(device).models],
                    "runtimes": catalog(device).runtimes,
                }
            )
        error.detail["runner_selection_request"] = {
            "runtime": config["runtime"],
            "execution_policy": policy,
            "model_policy": config["model_policy"],
            "environments": environments,
            "cloud_models": cloud_model_catalog(db, kwargs["user_id"]),
            "cloud_only": config["execution_policy"]["mode"] != "fixed",
            "automatic": bool(kwargs.get("automatic")),
            **({"recovery_from_environment_id": bound} if recovery else {}),
        }
