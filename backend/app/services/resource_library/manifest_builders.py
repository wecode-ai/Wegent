# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Build Resource Library install manifests from source resources."""

from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.resource_library import (
    RESOURCE_TYPE_AGENT,
    RESOURCE_TYPE_MCP,
    RESOURCE_TYPE_SKILL,
)
from app.models.skill_binary import SkillBinary


class ResourceManifestBuilder:
    """Build install manifests from existing user-owned resources."""

    def build(
        self,
        db: Session,
        *,
        user_id: int,
        resource_type: str,
        source_id: int,
        options: dict[str, Any],
    ) -> dict[str, Any]:
        explicit_manifest = options.get("manifest")
        if isinstance(explicit_manifest, dict):
            return {
                "resource_type": resource_type,
                "source_id": source_id,
                **explicit_manifest,
            }

        if resource_type == RESOURCE_TYPE_AGENT:
            return self._build_agent_manifest(db, user_id=user_id, source_id=source_id)
        if resource_type == RESOURCE_TYPE_SKILL:
            return self._build_skill_manifest(db, user_id=user_id, source_id=source_id)
        if resource_type == RESOURCE_TYPE_MCP:
            return self._build_mcp_manifest(source_id=source_id, options=options)

        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported resource type",
        )

    def _build_agent_manifest(
        self,
        db: Session,
        *,
        user_id: int,
        source_id: int,
    ) -> dict[str, Any]:
        team = (
            db.query(Kind)
            .filter(
                Kind.id == source_id,
                Kind.kind == "Team",
                Kind.user_id == user_id,
                Kind.is_active == True,
            )
            .first()
        )
        if not team:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Agent not found",
            )

        return {
            "resource_type": RESOURCE_TYPE_AGENT,
            "team": team.json,
            "source": {
                "kind_id": team.id,
                "namespace": team.namespace,
                "name": team.name,
            },
        }

    def _build_skill_manifest(
        self,
        db: Session,
        *,
        user_id: int,
        source_id: int,
    ) -> dict[str, Any]:
        skill = (
            db.query(Kind)
            .filter(
                Kind.id == source_id,
                Kind.kind == "Skill",
                Kind.user_id == user_id,
                Kind.is_active == True,
            )
            .first()
        )
        if not skill:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Skill not found",
            )

        binary = db.query(SkillBinary).filter(SkillBinary.kind_id == skill.id).first()

        return {
            "resource_type": RESOURCE_TYPE_SKILL,
            "skill": skill.json,
            "source": {
                "kind_id": skill.id,
                "binary_id": binary.id if binary else None,
                "namespace": skill.namespace,
                "name": skill.name,
            },
        }

    def _build_mcp_manifest(
        self,
        *,
        source_id: int,
        options: dict[str, Any],
    ) -> dict[str, Any]:
        server_name = options.get("server_name") or f"mcp-{source_id}"
        server_config = dict(options.get("server_config") or {})
        safe_template: dict[str, Any] = {
            "type": server_config.get("type", "streamable-http"),
            "url": "",
        }

        if server_config.get("command"):
            safe_template["command"] = server_config["command"]
            safe_template["args"] = server_config.get("args", [])

        return {
            "resource_type": RESOURCE_TYPE_MCP,
            "server_name": server_name,
            "server_config_template": safe_template,
            "required_fields": ["url"],
        }
