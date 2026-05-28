# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Install Resource Library versions into user-owned resources."""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.resource_library import (
    RESOURCE_TYPE_AGENT,
    RESOURCE_TYPE_MCP,
    RESOURCE_TYPE_SKILL,
    ResourceLibraryListing,
    ResourceLibraryVersion,
)
from app.models.skill_binary import SkillBinary
from app.models.user import User
from app.services.user_mcp_service import UserMCPService
from shared.utils.crypto import encrypt_sensitive_data


@dataclass
class ResourceInstallResult:
    installed_kind_id: int | None
    installed_reference: dict[str, Any]
    requires_configuration: bool = False


def _resource_name_from_manifest(
    listing: ResourceLibraryListing, manifest: dict[str, Any], key: str
) -> str:
    resource = manifest.get(key)
    if isinstance(resource, dict):
        metadata = resource.get("metadata")
        if isinstance(metadata, dict) and metadata.get("name"):
            return str(metadata["name"])
    return listing.name


class AgentResourceInstaller:
    """Install Agent resources by copying the Team snapshot."""

    def install(
        self,
        db: Session,
        *,
        user_id: int,
        listing: ResourceLibraryListing,
        version: ResourceLibraryVersion,
        target_namespace: str,
        options: dict[str, Any],
    ) -> ResourceInstallResult:
        manifest = version.manifest or {}
        team_json = copy.deepcopy(manifest.get("team") or {})
        if not isinstance(team_json, dict):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid agent manifest",
            )

        name = _resource_name_from_manifest(listing, manifest, "team")
        existing = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Team",
                Kind.name == name,
                Kind.namespace == target_namespace,
                Kind.is_active == True,
            )
            .first()
        )
        if existing:
            return ResourceInstallResult(
                installed_kind_id=existing.id,
                installed_reference={
                    "team_id": existing.id,
                    "namespace": existing.namespace,
                    "name": existing.name,
                    "kind": "Team",
                },
            )

        metadata = dict(team_json.get("metadata") or {})
        metadata["name"] = name
        metadata["namespace"] = target_namespace
        team_json["metadata"] = metadata

        team = Kind(
            user_id=user_id,
            kind="Team",
            name=name,
            namespace=target_namespace,
            json=team_json,
            is_active=True,
        )
        db.add(team)
        db.flush()

        return ResourceInstallResult(
            installed_kind_id=team.id,
            installed_reference={
                "team_id": team.id,
                "namespace": team.namespace,
                "name": team.name,
                "kind": "Team",
            },
        )


class SkillResourceInstaller:
    """Install Skill resources by copying the Skill snapshot and ZIP binary."""

    def install(
        self,
        db: Session,
        *,
        user_id: int,
        listing: ResourceLibraryListing,
        version: ResourceLibraryVersion,
        target_namespace: str,
        options: dict[str, Any],
    ) -> ResourceInstallResult:
        manifest = version.manifest or {}
        skill_json = copy.deepcopy(manifest.get("skill") or {})
        if not isinstance(skill_json, dict):
            skill_json = {}

        name = _resource_name_from_manifest(listing, manifest, "skill")
        existing = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Skill",
                Kind.name == name,
                Kind.namespace == target_namespace,
                Kind.is_active == True,
            )
            .first()
        )
        if existing:
            return ResourceInstallResult(
                installed_kind_id=existing.id,
                installed_reference={
                    "skill_id": existing.id,
                    "namespace": existing.namespace,
                    "name": existing.name,
                    "kind": "Skill",
                },
            )

        metadata = dict(skill_json.get("metadata") or {})
        metadata["name"] = name
        metadata["namespace"] = target_namespace
        skill_json = {
            "apiVersion": skill_json.get("apiVersion", "agent.wecode.io/v1"),
            "kind": "Skill",
            "metadata": metadata,
            "spec": dict(skill_json.get("spec") or {}),
        }

        skill = Kind(
            user_id=user_id,
            kind="Skill",
            name=name,
            namespace=target_namespace,
            json=skill_json,
            is_active=True,
        )
        db.add(skill)
        db.flush()

        source_binary_id = None
        source = manifest.get("source")
        if isinstance(source, dict):
            source_binary_id = source.get("binary_id")
        source_binary_id = source_binary_id or version.source_binary_id
        if source_binary_id:
            source_binary = (
                db.query(SkillBinary).filter(SkillBinary.id == source_binary_id).first()
            )
            if source_binary:
                db.add(
                    SkillBinary(
                        kind_id=skill.id,
                        binary_data=source_binary.binary_data,
                        file_size=source_binary.file_size,
                        file_hash=source_binary.file_hash,
                    )
                )

        return ResourceInstallResult(
            installed_kind_id=skill.id,
            installed_reference={
                "skill_id": skill.id,
                "namespace": skill.namespace,
                "name": skill.name,
                "kind": "Skill",
            },
        )


class McpResourceInstaller:
    """Install MCP resources into user preferences."""

    def install(
        self,
        db: Session,
        *,
        user_id: int,
        listing: ResourceLibraryListing,
        version: ResourceLibraryVersion,
        target_namespace: str,
        options: dict[str, Any],
    ) -> ResourceInstallResult:
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="User not found"
            )

        manifest = version.manifest or {}
        service_id = listing.name
        server_name = manifest.get("server_name") or listing.name
        url = str(options.get("url") or "").strip()
        requires_configuration = (
            "url" in (manifest.get("required_fields") or []) and not url
        )

        prefs = UserMCPService.load_preferences(user.preferences)
        mcps = dict(prefs.get("mcps") or {})
        provider = dict(mcps.get("resource_library") or {})
        services = dict(provider.get("services") or {})
        service_config = {
            "enabled": bool(url),
            "server_name": server_name,
            "resource_library_listing_id": listing.id,
        }
        if url:
            service_config["credentials"] = {"url": encrypt_sensitive_data(url)}

        services[service_id] = service_config
        provider["services"] = services
        mcps["resource_library"] = provider
        prefs["mcps"] = mcps
        user.preferences = UserMCPService.dump_preferences(prefs)
        db.add(user)
        db.flush()

        return ResourceInstallResult(
            installed_kind_id=None,
            installed_reference={
                "provider_id": "resource_library",
                "service_id": service_id,
                "server_name": server_name,
                "resource_type": RESOURCE_TYPE_MCP,
                "requires_configuration": requires_configuration,
            },
            requires_configuration=requires_configuration,
        )


class ResourceLibraryInstaller:
    """Dispatch installation to the installer for each resource type."""

    def __init__(self) -> None:
        self._installers = {
            RESOURCE_TYPE_AGENT: AgentResourceInstaller(),
            RESOURCE_TYPE_SKILL: SkillResourceInstaller(),
            RESOURCE_TYPE_MCP: McpResourceInstaller(),
        }

    def install(
        self,
        db: Session,
        *,
        user_id: int,
        listing: ResourceLibraryListing,
        version: ResourceLibraryVersion,
        target_namespace: str,
        options: dict[str, Any],
    ) -> ResourceInstallResult:
        installer = self._installers.get(listing.resource_type)
        if not installer:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unsupported resource type",
            )

        return installer.install(
            db,
            user_id=user_id,
            listing=listing,
            version=version,
            target_namespace=target_namespace,
            options=options,
        )
