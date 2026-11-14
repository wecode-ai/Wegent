"""Authorized cloud model metadata for collaboration routing; no credentials."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.schemas.runner_routing import ModelIdentity
from app.services.execution_permission_scope import execution_resource_scope
from app.services.model_aggregation_service import model_aggregation_service


def cloud_model_catalog(db: Session, user_id: int) -> list[dict]:
    """Return the visible authorized cloud models a runner may select."""
    user = db.get(User, user_id)
    if user is None:
        return []
    return [
        {
            **model,
            "config": {
                key: value
                for key, value in (model.get("config") or {}).items()
                if key
                in {
                    "protocol",
                    "apiFormat",
                    "api_format",
                    "wire_api",
                    "codex_catalog_model_id",
                    "native_tool_search",
                    "native_namespace_tools",
                }
            },
        }
        for model in model_aggregation_service.list_available_models(
            db,
            user,
            include_config=False,
            scope="all",
            model_category_type="llm",
            client_origin="wework",
        )
        if model["type"] in {"public", "user", "group"} and model.get("isActive", True)
    ]


def _persisted_cloud_model_kind(
    db: Session, user: User, model: ModelIdentity
) -> Kind | None:
    """Load a persisted model reference without applying catalog visibility.

    Hiding a public model (``spec.isVisible=false``) removes it from new
    selections, but an agent or task configured earlier keeps its reference.
    The reference still has to name an active Model the user may access.
    """
    from app.services.adapters.public_model import is_public_model_allowed_for_user

    ref = model.cloud_model
    kind = (
        db.query(Kind)
        .filter(
            Kind.user_id == ref.resource_user_id,
            Kind.kind == "Model",
            Kind.namespace == ref.namespace,
            Kind.name == ref.name,
            Kind.is_active.is_(True),
        )
        .first()
    )
    if kind is None:
        return None
    if ref.type == "public" and not is_public_model_allowed_for_user(
        kind.json, user.user_name
    ):
        return None
    # Hidden is the only state a persisted reference survives. The Wework
    # availability and model-category filters still describe whether this
    # reference can serve a Wework LLM run at all.
    from app.schemas.kind import Model as ModelCRD
    from app.schemas.kind import resolve_model_category

    try:
        crd = ModelCRD.model_validate(kind.json)
    except Exception:
        return None
    if (
        not bool(crd.spec.isWeworkAvailable)
        or resolve_model_category(kind.json.get("spec") or {}) != "llm"
    ):
        return None
    return kind


@execution_resource_scope()
def require_cloud_model(
    db: Session,
    user_id: int,
    model: ModelIdentity,
    *,
    allow_hidden: bool = False,
) -> dict:
    """Authorize one cloud model reference for execution.

    ``allow_hidden`` is for references persisted in agent policies and runtime
    snapshots: the admin "offline" state only hides a model from new
    selections, so a previously configured reference must still resolve. New
    user selections keep ``allow_hidden=False`` and must come from the visible
    catalog.
    """
    from app.services.llm_proxy_service import (
        resolve_llm_proxy_model_config,
        resolve_llm_proxy_protocol,
    )
    from app.services.runner_routing import routing_error

    ref = model.cloud_model
    user = db.get(User, user_id)
    if ref is None or user is None:
        raise routing_error(
            "RUNNER_MODEL_UNAVAILABLE", "Cloud model identity is unavailable"
        )
    available = any(
        item["name"] == ref.name
        and item["type"] == ref.type
        and item.get("namespace") == ref.namespace
        and item.get("resourceUserId") == ref.resource_user_id
        for item in cloud_model_catalog(db, user_id)
    )
    if not available and (
        not allow_hidden or _persisted_cloud_model_kind(db, user, model) is None
    ):
        raise routing_error(
            "RUNNER_MODEL_UNAVAILABLE",
            "The cloud model is not available to this user",
        )
    try:
        config = resolve_llm_proxy_model_config(
            db,
            user,
            model_name=ref.name,
            model_type=ref.type,
            namespace=ref.namespace,
            resource_user_id=ref.resource_user_id,
        )
        protocol = resolve_llm_proxy_protocol(ref.name, config)
    except HTTPException as error:
        raise routing_error(
            "RUNNER_MODEL_UNAVAILABLE",
            "The cloud model is unavailable, misconfigured, or no longer "
            "authorized for this user",
        ) from error
    return {
        "weworkCloudModelNamespace": ref.namespace,
        "weworkCloudModelResourceUserId": str(ref.resource_user_id),
        "weworkCloudModelUpstreamApiFormat": protocol,
    }


def execution_model_values(
    db: Session, user_id: int, device: Kind, model: ModelIdentity
) -> tuple[str, str, dict, str]:
    """Resolve a persisted model identity into executor routing fields."""
    from app.services.runner_routing import matching_model, routing_error

    if model.source == "cloud":
        options = require_cloud_model(db, user_id, model, allow_hidden=True)
        ref = model.cloud_model
        return ref.name, ref.type, options, f"cloud_gateway:user:{user_id}"
    native = matching_model(device, model)
    if native is None:
        raise routing_error(
            "RUNNER_MODEL_UNAVAILABLE", "The runner no longer supports this local model"
        )
    return (
        native.local_model_id,
        "runtime",
        {"runnerModelProvider": native.provider},
        native.account_label,
    )


def fixed_model_config(db: Session, user_id: int, model: ModelIdentity) -> dict:
    """Compile an agent policy through the same gateway as explicit selections."""
    if model.source == "native":
        return {"model_id": model.model_id, "model_provider": model.provider}

    from app.services.runtime_work_service import _runtime_model_override_values

    options = require_cloud_model(db, user_id, model, allow_hidden=True)
    ref = model.cloud_model
    config, _, _ = _runtime_model_override_values(
        db=db,
        user_id=user_id,
        runtime=model.runtime,
        model_id=ref.name,
        model_type=ref.type,
        model_options=options,
    )
    return config
