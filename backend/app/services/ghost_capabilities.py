# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Load and merge one-level Ghost capability inheritance."""

import json
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.kind import Ghost, GhostRef, SkillRefMeta
from app.services.readers import KindType, kindReader


@dataclass
class MergedGhostCapabilities:
    """Capabilities merged from the base Ghost first, then the custom Ghost."""

    mcp_servers: dict[str, Any] = field(default_factory=dict)
    skills: list[str] = field(default_factory=list)
    skill_refs: dict[str, SkillRefMeta] = field(default_factory=dict)
    skill_namespaces: dict[str, str] = field(default_factory=dict)
    preload_skills: list[str] = field(default_factory=list)
    preload_skill_refs: dict[str, SkillRefMeta] = field(default_factory=dict)
    plugins: list[dict[str, Any]] = field(default_factory=list)


def load_ghost_chain(
    db: Session,
    *,
    owner_user_id: int,
    ghost_ref: GhostRef,
) -> list[tuple[Kind, Ghost]]:
    """Load an optional public base Ghost and the custom Ghost."""
    ghost = kindReader.get_by_name_and_namespace(
        db,
        owner_user_id,
        KindType.GHOST,
        ghost_ref.namespace,
        ghost_ref.name,
    )
    if not ghost or not ghost.json:
        return []

    ghost_crd = Ghost.model_validate(ghost.json)
    chain: list[tuple[Kind, Ghost]] = []
    base_ref = ghost_crd.spec.baseGhostRef
    if base_ref is not None:
        if (
            base_ref.user_id == owner_user_id
            and base_ref.namespace == ghost_ref.namespace
            and base_ref.name == ghost_ref.name
        ):
            raise ValueError("Ghost cannot inherit from itself")
        base_ghost = kindReader.get_by_name_and_namespace(
            db,
            base_ref.user_id,
            KindType.GHOST,
            base_ref.namespace,
            base_ref.name,
        )
        if not base_ghost or not base_ghost.json:
            raise ValueError(
                f"Base Ghost '{base_ref.namespace}/{base_ref.name}' is unavailable"
            )
        base_crd = Ghost.model_validate(base_ghost.json)
        if base_crd.spec.baseGhostRef is not None:
            raise ValueError("Nested base Ghost inheritance is not supported")
        chain.append((base_ghost, base_crd))

    chain.append((ghost, ghost_crd))
    return chain


def merge_ghost_capabilities(
    ghost_chain: list[tuple[Kind, Ghost]],
) -> MergedGhostCapabilities:
    """Merge capabilities with custom values overriding same-name base values."""
    merged = MergedGhostCapabilities()
    seen_skills: set[str] = set()
    seen_preload_skills: set[str] = set()
    plugins_by_key: dict[str, dict[str, Any]] = {}

    for ghost, ghost_crd in ghost_chain:
        merged.mcp_servers.update(ghost_crd.spec.mcpServers or {})
        for skill_name in ghost_crd.spec.skills or []:
            if skill_name not in seen_skills:
                seen_skills.add(skill_name)
                merged.skills.append(skill_name)
            merged.skill_namespaces[skill_name] = ghost.namespace
        merged.skill_refs.update(ghost_crd.spec.skill_refs or {})
        for skill_name in ghost_crd.spec.preload_skills or []:
            if skill_name not in seen_preload_skills:
                seen_preload_skills.add(skill_name)
                merged.preload_skills.append(skill_name)
        merged.preload_skill_refs.update(ghost_crd.spec.preload_skill_refs or {})
        for plugin in ghost_crd.spec.plugins or []:
            plugins_by_key[_plugin_merge_key(plugin)] = plugin

    merged.plugins = list(plugins_by_key.values())
    return merged


def _plugin_merge_key(plugin: dict[str, Any]) -> str:
    plugin_id = plugin.get("id")
    if plugin_id is not None and str(plugin_id).strip():
        return f"id:{plugin_id}"

    plugin_name = plugin.get("pluginName") or plugin.get("name")
    if plugin_name:
        marketplace = plugin.get("marketplaceId") or plugin.get("marketplace") or ""
        return f"name:{marketplace}:{plugin_name}"

    return f"config:{json.dumps(plugin, sort_keys=True)}"
