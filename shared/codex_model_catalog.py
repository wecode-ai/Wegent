# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Data-driven lookup for Wework's built-in Codex capability catalogs."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

CATALOG_DIRECTORY = Path(__file__).resolve().parent / "assets" / "codex-models"
CODEX_CATALOG_MODEL_ID_KEYS = (
    "codex_catalog_model_id",
    "codexCatalogModelId",
)


def _normalized_strings(value: Any) -> tuple[str, ...]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return ()
    return tuple(
        item.strip().lower() for item in value if isinstance(item, str) and item.strip()
    )


def codex_catalog_model_id_from_config(
    config: Any,
    keys: tuple[str, ...] = CODEX_CATALOG_MODEL_ID_KEYS,
) -> Optional[str]:
    """Return the first independently validated catalog ID candidate."""

    if not isinstance(config, dict):
        return None
    for key in keys:
        candidate = config.get(key)
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return None


@lru_cache(maxsize=1)
def _catalog_models() -> tuple[dict[str, Any], ...]:
    models: list[dict[str, Any]] = []
    for path in sorted(CATALOG_DIRECTORY.glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        entries = payload.get("models") if isinstance(payload, dict) else None
        if not isinstance(entries, list):
            continue
        models.extend(entry for entry in entries if isinstance(entry, dict))
    return tuple(models)


def codex_catalog_model_id_for_upstream(
    model_id: Any,
    upstream_api_format: Any = None,
) -> Optional[str]:
    """Resolve a catalog slug from declarative upstream identity metadata."""

    if not isinstance(model_id, str) or not model_id.strip():
        return None
    normalized_model_id = model_id.strip().lower()
    normalized_api_format = (
        upstream_api_format.strip().lower()
        if isinstance(upstream_api_format, str)
        else ""
    )
    for model in _catalog_models():
        api_formats = _normalized_strings(model.get("upstream_api_formats"))
        if api_formats and normalized_api_format not in api_formats:
            continue
        exact_model_ids = _normalized_strings(model.get("upstream_model_ids"))
        exact_model_id = model.get("upstream_model_id")
        if isinstance(exact_model_id, str) and exact_model_id.strip():
            exact_model_ids += (exact_model_id.strip().lower(),)
        exact_match = normalized_model_id in exact_model_ids
        contains_match = any(
            fragment in normalized_model_id
            for fragment in _normalized_strings(model.get("upstream_model_id_contains"))
        )
        slug = model.get("slug")
        if (exact_match or contains_match) and isinstance(slug, str) and slug.strip():
            return slug.strip()
    return None
