# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Bulk model reads for namespaces already selected by the listing service."""

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.services.kind import kind_service


def load_direct_models_by_namespace(
    db: Session, *, user_id: int, namespaces: list[str]
) -> dict[str, list[Kind]]:
    """Keep personal ownership filtering and batch the visible group models."""
    result: dict[str, list[Kind]] = {name: [] for name in namespaces}
    if "default" in result:
        result["default"] = kind_service.list_resources(
            user_id=user_id, kind="Model", namespace="default"
        )
    group_names = [name for name in result if name != "default"]
    if group_names:
        models = (
            db.query(Kind)
            .filter(
                Kind.kind == "Model",
                Kind.namespace.in_(group_names),
                Kind.is_active.is_(True),
            )
            .all()
        )
        for model in models:
            result[model.namespace].append(model)
    return result
