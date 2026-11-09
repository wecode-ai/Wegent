# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Resolve model identities from the same authorized catalog as Wework."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.schemas.kind import Model, resolve_model_category
from app.schemas.runtime_work import RuntimeModelSelection
from app.schemas.wework_api import WeworkResponseCreate
from app.services import runtime_work_service as runtime
from app.services.adapters.public_model import is_public_model_allowed_for_user
from app.services.chat.config.model_lookup import PublicModelAccessDeniedError
from app.services.chat.config.model_resolver import _find_model_with_namespace
from app.services.group_permission import get_user_groups
from app.services.llm_proxy_service import SUPPORTED_MODEL_TYPES
from app.services.model_aggregation_service import model_aggregation_service


def catalog(db: Session, user: User) -> list[dict]:
    # Match the desktop catalog: the gateway adapts upstream model protocols.
    # Native Codex shell filtering would hide supported Anthropic/chat models.
    return model_aggregation_service.list_available_models(
        db=db,
        current_user=user,
        scope="all",
        include_config=False,
        model_category_type="llm",
        client_origin="wework",
    )


def model_identifier(model: dict) -> str:
    return ":".join(
        str(model.get(key, ""))
        for key in ("type", "namespace", "resourceUserId", "name")
    )


def list_models(db: Session, user: User) -> dict:
    return {
        "object": "list",
        "data": [
            {
                "id": model_identifier(model),
                "object": "model",
                "created": 0,
                "owned_by": model["type"],
                "name": model["name"],
            }
            for model in catalog(db, user)
        ],
    }


def _unavailable() -> HTTPException:
    return HTTPException(
        422, "Model unavailable or ambiguous; use an id from GET /models"
    )


def _parse_model_identifier(value: str) -> tuple[str, str, int, str] | None:
    """Parse the ``type:namespace:resourceUserId:name`` catalog identifier."""
    parts = value.split(":", 3)
    if len(parts) != 4:
        return None
    model_type, namespace, owner_raw, name = parts
    if model_type not in SUPPORTED_MODEL_TYPES or not namespace or not name:
        return None
    try:
        owner = int(owner_raw)
    except ValueError:
        return None
    return model_type, namespace, owner, name


def _is_llm_model(kind: Kind) -> bool:
    json_data = kind.json if isinstance(kind.json, dict) else {}
    spec = json_data.get("spec") if isinstance(json_data.get("spec"), dict) else {}
    return resolve_model_category(spec) == "llm"


def _is_wework_available(kind: Kind) -> bool:
    try:
        return bool(Model.model_validate(kind.json).spec.isWeworkAvailable)
    except Exception:
        return False


def _exact_persisted_kind(
    db: Session,
    user: User,
    model_type: str,
    namespace: str,
    owner: int,
    name: str,
) -> Kind | None:
    """Read one persisted model identity without the catalog visibility filter.

    ``isVisible`` only controls new selections. The model must still be active,
    of the declared ownership scope, and accessible to the caller (group
    membership or the public-model user whitelist).
    """
    if model_type == "public":
        if namespace != "default" or owner != 0:
            return None
    elif model_type == "user":
        if namespace != "default" or owner != user.id:
            return None
    elif model_type == "group":
        if namespace == "default" or namespace not in get_user_groups(db, user.id):
            return None
    else:
        return None

    kind = (
        db.query(Kind)
        .filter(
            Kind.user_id == owner,
            Kind.kind == "Model",
            Kind.namespace == namespace,
            Kind.name == name,
            Kind.is_active.is_(True),
        )
        .first()
    )
    if kind is None:
        return None
    if model_type == "public" and not is_public_model_allowed_for_user(
        kind.json, user.user_name
    ):
        return None
    return kind


def _persisted_selection(
    db: Session,
    user: User,
    body: WeworkResponseCreate,
) -> RuntimeModelSelection:
    """Resolve a conversation's recorded model after it left the catalog."""
    identity = _parse_model_identifier(body.model)
    if identity is not None:
        model_type, namespace, owner, name = identity
        kind = _exact_persisted_kind(db, user, model_type, namespace, owner, name)
        if kind is None:
            raise _unavailable()
    else:
        model_type = ""
        namespace = ""
        owner = 0
        try:
            kind, spec = _find_model_with_namespace(db, body.model, user.id)
        except PublicModelAccessDeniedError:
            kind, spec = None, None
        if kind is None or not spec:
            raise _unavailable()
        namespace = kind.namespace or "default"
        owner = int(kind.user_id or 0)
        model_type = (
            "public" if owner == 0 else "group" if namespace != "default" else "user"
        )

    requested_type = body.execution.model_type if body.execution else None
    if requested_type and requested_type != model_type:
        raise _unavailable()
    if not _is_llm_model(kind) or not _is_wework_available(kind):
        raise _unavailable()

    options = dict(body.execution.model_options) if body.execution else {}
    options[runtime.CLOUD_MODEL_NAMESPACE_OPTION] = namespace
    options[runtime.CLOUD_MODEL_RESOURCE_USER_ID_OPTION] = owner
    return RuntimeModelSelection(
        modelName=kind.name,
        modelType=model_type,
        options=options,
    )


def selection(
    db: Session,
    user: User,
    body: WeworkResponseCreate,
    *,
    allow_hidden: bool = False,
) -> RuntimeModelSelection:
    matches = [
        model
        for model in catalog(db, user)
        if body.model in {model_identifier(model), model["name"]}
        and (
            not body.execution
            or not body.execution.model_type
            or model["type"] == body.execution.model_type
        )
    ]
    if len(matches) > 1:
        raise _unavailable()
    if not matches:
        if allow_hidden:
            return _persisted_selection(db, user, body)
        raise _unavailable()
    model = matches[0]
    options = dict(body.execution.model_options) if body.execution else {}
    options[runtime.CLOUD_MODEL_NAMESPACE_OPTION] = model.get("namespace", "default")
    options[runtime.CLOUD_MODEL_RESOURCE_USER_ID_OPTION] = model.get(
        "resourceUserId", 0
    )
    return RuntimeModelSelection(
        modelName=model["name"], modelType=model["type"], options=options
    )
