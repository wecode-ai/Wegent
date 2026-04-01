# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.services.chat.config import extract_and_process_model_config


def resolve_prompt_draft_model_config(
    db: Session,
    current_user: User,
    requested_model_name: str | None,
) -> tuple[dict[str, Any] | None, str]:
    model_kind = None
    if requested_model_name:
        model_kind = (
            db.query(Kind)
            .filter(
                Kind.kind == "Model",
                Kind.name == requested_model_name,
                Kind.is_active == True,
                Kind.user_id.in_([current_user.id, 0]),
            )
            .first()
        )
        if not model_kind:
            raise ValueError("model_not_found")
    else:
        model_kind = (
            db.query(Kind)
            .filter(
                Kind.kind == "Model",
                Kind.is_active == True,
                Kind.user_id == current_user.id,
            )
            .first()
        )
        if not model_kind:
            model_kind = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Model",
                    Kind.is_active == True,
                    Kind.user_id == 0,
                )
                .first()
            )

    if not model_kind:
        return None, requested_model_name or ""

    model_spec = (model_kind.json or {}).get("spec", {})
    model_config = extract_and_process_model_config(
        model_spec=model_spec,
        user_id=current_user.id,
        user_name=current_user.user_name or "",
    )
    return model_config, model_kind.name
