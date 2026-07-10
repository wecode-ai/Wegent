# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
"""Shared Model Kind reference resolver for multimodal analysis.

Extracted into a single canonical path so that multimodal analysis (and any
future LLM caller) share one resolution surface and one billing attribution.

The resolver performs two jobs:
1. Look up the referenced Model Kind with the public/user/group scoping.
2. Decrypt the api_key + resolve placeholders via
   ``extract_and_process_model_config`` (only the backend can decrypt).

Billing attribution (``model_type``) is injected here so every caller goes
through the same surface; bypassing the resolver leaves ``model_type`` unset
and breaks billing attribution.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.services.chat.config.model_resolver import (
    extract_and_process_model_config,
)

logger = logging.getLogger(__name__)

# Supported model_ref.type values. Any other type used to fall through to the
# non-public branch of _lookup_model_spec, which queries by namespace WITHOUT a
# user_id filter — with namespace="default" that could resolve another user's
# personal model and decrypt its config. Reject unknown types up-front.
VALID_MODEL_REF_TYPES = frozenset({"public", "user", "group"})


class ModelRefResolutionError(ValueError):
    """Raised when a model reference is structurally invalid or unresolved.

    Carries a stable ``code`` so the API layer can map it to a user-facing
    error message without parsing the text.
    """

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def resolve_model_config_by_ref(
    db: Session,
    *,
    model_ref: Dict[str, Any],
    user_id: int,
    user_name: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Resolve ``{name, namespace, type}`` → processed model config.

    Mirrors the public/user/group scoping + ``extract_and_process_model_config``
    decryption. Returns ``None`` if the referenced model is not found; raises
    :class:`ModelRefResolutionError` if the ref is structurally invalid.
    """
    if not model_ref:
        return None

    model_name = model_ref.get("name")
    model_namespace = model_ref.get("namespace", "default")
    model_type = model_ref.get("type", "public")

    if not model_name:
        raise ModelRefResolutionError(
            "invalid_model_ref", f"missing 'name': {model_ref}"
        )
    if model_type not in VALID_MODEL_REF_TYPES:
        raise ModelRefResolutionError(
            "invalid_model_ref", f"unsupported 'type': {model_type}"
        )
    if model_type == "group" and model_namespace == "default":
        # group models live in a named group namespace; the default namespace is
        # personal, so a "group" ref against it would query without a user_id
        # filter and could match another user's personal model.
        raise ModelRefResolutionError(
            "invalid_model_ref", "group model refs must use a non-default namespace"
        )

    logger.info(
        "[ModelRefResolver] resolving name=%s namespace=%s type=%s",
        model_name,
        model_namespace,
        model_type,
    )

    model_spec = _lookup_model_spec(
        db,
        model_name=model_name,
        model_namespace=model_namespace,
        model_type=model_type,
        user_id=user_id,
    )
    if model_spec is None:
        logger.warning(
            "[ModelRefResolver] model not found: name=%s type=%s user_id=%s",
            model_name,
            model_type,
            user_id,
        )
        return None

    try:
        cfg = extract_and_process_model_config(
            model_spec=model_spec,
            user_id=user_id,
            user_name=user_name,
        )
    except Exception as e:
        logger.error(
            "[ModelRefResolver] process failed for %s: %s",
            model_name,
            e,
            exc_info=True,
        )
        return None

    # Audit fields for billing attribution. ``model`` from
    # extract_and_process_model_config is the *provider* (gemini/openai), not
    # the scope; ``model_type`` (public/user/group) is the billing surface and
    # is injected here so callers cannot bypass it.
    cfg.setdefault("model_name", model_name)
    cfg.setdefault("model_namespace", model_namespace)
    cfg.setdefault("model_type", model_type)
    logger.info(
        "[ModelRefResolver] resolved: model_id=%s has_api_key=%s type=%s",
        cfg.get("model_id"),
        bool(cfg.get("api_key")),
        model_type,
    )
    return cfg


def _lookup_model_spec(
    db: Session,
    *,
    model_name: str,
    model_namespace: str,
    model_type: str,
    user_id: int,
) -> Optional[Dict[str, Any]]:
    """Look up a Model Kind spec by type-scoped user_id.

    Identical scoping to the summary path: ``public`` → user_id=0 + default
    namespace; ``user`` → user_id-scoped; ``group`` → namespace-scoped (no
    user_id filter).
    """
    if model_type == "public":
        model = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Model",
                Kind.name == model_name,
                Kind.namespace == "default",
                Kind.is_active.is_(True),
            )
            .first()
        )
    else:
        query = db.query(Kind).filter(
            Kind.kind == "Model",
            Kind.name == model_name,
            Kind.namespace == model_namespace,
            Kind.is_active.is_(True),
        )
        if model_type == "user":
            query = query.filter(Kind.user_id == user_id)
        model = query.first()

    if model is None:
        return None
    return (model.json or {}).get("spec", {})


def resolve_multimodal_analysis_model(
    db: Session,
    *,
    kb: Optional[Kind],
    user_id: int,
    user_name: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Resolve the multimodal analysis model from a KB's ``multimodalAnalysisModelRef``.

    Single source of truth: ``kb.spec.multimodalAnalysisModelRef`` (set by the KB
    form). One model serves BOTH video and image analysis. ``user_id`` should be
    the document uploader (per-uploader billing); returns ``None`` if not
    configured so the caller can reject.
    """
    if kb is None:
        return None
    kb_ref = (kb.json or {}).get("spec", {}).get("multimodalAnalysisModelRef")
    if not kb_ref:
        return None
    return resolve_model_config_by_ref(
        db,
        model_ref=kb_ref,
        user_id=user_id,
        user_name=user_name,
    )
