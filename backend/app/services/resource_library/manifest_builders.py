# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from copy import deepcopy
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

SENSITIVE_MCP_KEYS = {
    "apikey",
    "authorization",
    "headers",
    "password",
    "secret",
    "token",
}


class ResourceManifestBuilder:
    """Build install manifests from source resources."""

    def build(
        self,
        db: Session,
        *,
        user_id: int,
        resource_type: str,
        source_id: int,
        options: dict[str, Any],
    ) -> dict[str, Any]:
        if resource_type == RESOURCE_TYPE_AGENT:
            return self._build_agent_manifest(
                db,
                user_id=user_id,
                source_id=source_id,
            )
        if resource_type == RESOURCE_TYPE_SKILL:
            return self._build_skill_manifest(
                db,
                user_id=user_id,
                source_id=source_id,
            )
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
        team = self._get_active_kind(
            db,
            user_id=user_id,
            source_id=source_id,
            kind="Team",
            not_found_detail="Agent not found",
        )
        return {
            "resource_type": RESOURCE_TYPE_AGENT,
            "team": deepcopy(team.json),
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
        skill = self._get_active_kind(
            db,
            user_id=user_id,
            source_id=source_id,
            kind="Skill",
            not_found_detail="Skill not found",
        )
        binary = db.query(SkillBinary).filter(SkillBinary.kind_id == skill.id).first()
        return {
            "resource_type": RESOURCE_TYPE_SKILL,
            "skill": deepcopy(skill.json),
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
        server_config = options.get("server_config") or {}
        if not isinstance(server_config, dict):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="MCP server_config must be an object",
            )

        template = self._sanitize_mcp_config(server_config)
        template.setdefault("type", "streamable-http")
        template["url"] = ""

        return {
            "resource_type": RESOURCE_TYPE_MCP,
            "server_name": server_name,
            "server_config_template": template,
            "required_fields": self._required_fields(template),
        }

    def _get_active_kind(
        self,
        db: Session,
        *,
        user_id: int,
        source_id: int,
        kind: str,
        not_found_detail: str,
    ) -> Kind:
        source = (
            db.query(Kind)
            .filter(
                Kind.id == source_id,
                Kind.kind == kind,
                Kind.user_id == user_id,
                Kind.is_active.is_(True),
            )
            .first()
        )
        if not source:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=not_found_detail,
            )
        return source

    def _sanitize_mcp_config(self, value: Any) -> Any:
        if isinstance(value, dict):
            safe_config = {}
            for key, item in value.items():
                if self._is_sensitive_key(key):
                    continue
                if key == "url":
                    safe_config[key] = ""
                    continue
                safe_config[key] = self._sanitize_mcp_config(item)
            return safe_config
        if isinstance(value, list):
            return [self._sanitize_mcp_config(item) for item in value]
        return value

    def _is_sensitive_key(self, key: Any) -> bool:
        if not isinstance(key, str):
            return False
        normalized = "".join(char for char in key.lower() if char.isalnum())
        return any(secret_key in normalized for secret_key in SENSITIVE_MCP_KEYS)

    def _required_fields(self, template: dict[str, Any]) -> list[str]:
        return [key for key, value in template.items() if value == ""]
