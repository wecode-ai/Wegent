# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Runtime-only Codex model definitions."""

from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models.user import User
from app.services.user_runtime_config import user_runtime_config_service

CODEX_RUNTIME = "codex"
CODEX_RUNTIME_MODEL_NAME = "codex-gpt-5.5"
CODEX_RUNTIME_MODEL_NAMESPACE = "default"
CODEX_RUNTIME_MODEL_DISPLAY_NAME = "GPT-5.5 (Codex)"
CODEX_RUNTIME_MODEL_PROVIDER = "openai"
CODEX_RUNTIME_MODEL_ID = "gpt-5.5"
CODEX_RUNTIME_MODEL_PROTOCOL = "openai-responses"
CODEX_RUNTIME_MODEL_API_FORMAT = "responses"
CODEX_RUNTIME_MODEL_CATEGORY_TYPE = "llm"
CODEX_RUNTIME_MODEL_GROUP = "Codex"
CODEX_RUNTIME_MODEL_SUB_GROUP = "Personal"


def is_codex_runtime_model_name(model_name: Optional[str]) -> bool:
    """Return whether a name refers to the runtime-only Codex GPT model."""
    return model_name == CODEX_RUNTIME_MODEL_NAME


def build_codex_runtime_model_config() -> dict[str, Any]:
    """Build safe config for the unified model list response."""
    return {
        "protocol": CODEX_RUNTIME_MODEL_PROTOCOL,
        "apiFormat": CODEX_RUNTIME_MODEL_API_FORMAT,
        "ui": {
            "family": "gpt",
            "modelLabel": "GPT-5.5",
            "controls": ["speed"],
            "sortOrder": 10,
        },
    }


def build_codex_runtime_model_spec() -> dict[str, Any]:
    """Build a Model.spec-compatible runtime model spec for execution."""
    return {
        "modelConfig": {
            "env": {
                "model": CODEX_RUNTIME_MODEL_PROVIDER,
                "model_id": CODEX_RUNTIME_MODEL_ID,
            }
        },
        "protocol": CODEX_RUNTIME_MODEL_PROTOCOL,
        "apiFormat": CODEX_RUNTIME_MODEL_API_FORMAT,
        "modelType": CODEX_RUNTIME_MODEL_CATEGORY_TYPE,
    }


def is_codex_runtime_model_enabled(db: Session, user: User) -> bool:
    """Return whether the current user can use the runtime-only Codex model."""
    status = user_runtime_config_service.get_execution_config(
        db,
        user_id=user.id,
        runtime=CODEX_RUNTIME,
        preferences=getattr(user, "preferences", None),
    )
    return bool(status.get("configured") and status.get("use_user_config"))


def get_enabled_codex_runtime_model_spec(
    db: Session, user_id: int, model_name: str
) -> Optional[dict[str, Any]]:
    """Return the Codex runtime model spec when enabled for the user."""
    if not is_codex_runtime_model_name(model_name):
        return None

    user = db.query(User).filter(User.id == user_id).first()
    if not user or not is_codex_runtime_model_enabled(db, user):
        return None

    return build_codex_runtime_model_spec()
