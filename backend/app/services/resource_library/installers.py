# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.resource_library import ResourceLibraryListing, ResourceLibraryVersion
from app.models.skill_binary import SkillBinary
from app.models.user import User
from app.services.user_mcp_service import (
    MCP_CREDENTIALS_KEY,
    MCP_ROOT_KEY,
    MCP_SERVICES_KEY,
    MCP_URL_KEY,
    user_mcp_service,
)
from shared.utils.crypto import encrypt_sensitive_data, is_data_encrypted

RESOURCE_LIBRARY_MCP_PROVIDER_ID = "resource-library"


@dataclass
class ResourceInstallResult:
    """Result returned by type-specific resource installers."""

    installed_kind_id: int | None
    installed_reference: dict[str, Any] = field(default_factory=dict)
    requires_configuration: bool = False


def _available_kind_name(
    db: Session,
    *,
    user_id: int,
    kind: str,
    namespace: str,
    base_name: str,
) -> str:
    candidate = base_name
    suffix = 2
    while _kind_name_exists(
        db,
        user_id=user_id,
        kind=kind,
        namespace=namespace,
        name=candidate,
    ):
        candidate = f"{base_name}-{suffix}"
        suffix += 1
    return candidate


def _kind_name_exists(
    db: Session,
    *,
    user_id: int,
    kind: str,
    namespace: str,
    name: str,
) -> bool:
    return (
        db.query(Kind)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == kind,
            Kind.namespace == namespace,
            Kind.name == name,
            Kind.is_active.is_(True),
        )
        .first()
        is not None
    )


class AgentResourceInstaller:
    """Install Agent resources by copying Team CRD snapshots."""

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
        team_snapshot = self._team_snapshot(manifest)
        target_name = _available_kind_name(
            db,
            user_id=user_id,
            kind="Team",
            namespace=target_namespace,
            base_name=self._base_name(listing, manifest, team_snapshot),
        )
        team_json = self._target_team_json(
            team_snapshot,
            target_name=target_name,
            target_namespace=target_namespace,
        )

        new_team = Kind(
            user_id=user_id,
            kind="Team",
            name=target_name,
            namespace=target_namespace,
            json=team_json,
            is_active=True,
        )
        db.add(new_team)
        db.flush()
        return ResourceInstallResult(
            installed_kind_id=new_team.id,
            installed_reference={
                "team_id": new_team.id,
                "namespace": target_namespace,
                "name": target_name,
            },
        )

    def _team_snapshot(self, manifest: dict[str, Any]) -> dict[str, Any]:
        snapshot = manifest.get("team")
        if isinstance(snapshot, dict) and snapshot:
            return deepcopy(snapshot)

        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Source Team snapshot not found",
        )

    def _base_name(
        self,
        listing: ResourceLibraryListing,
        manifest: dict[str, Any],
        team_snapshot: dict[str, Any],
    ) -> str:
        metadata = team_snapshot.get("metadata")
        if isinstance(metadata, dict) and metadata.get("name"):
            return str(metadata["name"])

        source = manifest.get("source") or {}
        if source.get("name"):
            return str(source["name"])

        return listing.name

    def _target_team_json(
        self,
        team_snapshot: dict[str, Any],
        *,
        target_name: str,
        target_namespace: str,
    ) -> dict[str, Any]:
        team_json = deepcopy(team_snapshot)
        metadata = team_json.setdefault("metadata", {})
        metadata["name"] = target_name
        metadata["namespace"] = target_namespace
        team_json["kind"] = "Team"
        return team_json


class SkillResourceInstaller:
    """Install Skill resources into the current user's namespace."""

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
        skill_snapshot = self._skill_snapshot(manifest)
        source_binary = self._source_binary(db, manifest, skill_snapshot)
        target_name = self._available_name(
            db,
            user_id=user_id,
            namespace=target_namespace,
            base_name=self._base_name(listing, manifest, skill_snapshot),
        )
        skill_json = self._target_skill_json(
            skill_snapshot,
            target_name=target_name,
            target_namespace=target_namespace,
        )

        new_skill = Kind(
            user_id=user_id,
            kind="Skill",
            name=target_name,
            namespace=target_namespace,
            json=skill_json,
            is_active=True,
        )
        db.add(new_skill)
        db.flush()

        if source_binary:
            db.add(
                SkillBinary(
                    kind_id=new_skill.id,
                    binary_data=source_binary.binary_data,
                    file_size=source_binary.file_size,
                    file_hash=source_binary.file_hash,
                )
            )
            db.flush()

        return ResourceInstallResult(
            installed_kind_id=new_skill.id,
            installed_reference={
                "skill_id": new_skill.id,
                "namespace": target_namespace,
                "name": target_name,
            },
        )

    def _skill_snapshot(self, manifest: dict[str, Any]) -> dict[str, Any]:
        snapshot = manifest.get("skill")
        if isinstance(snapshot, dict):
            return deepcopy(snapshot)

        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Source Skill snapshot not found",
        )

    def _base_name(
        self,
        listing: ResourceLibraryListing,
        manifest: dict[str, Any],
        skill_snapshot: dict[str, Any],
    ) -> str:
        metadata = skill_snapshot.get("metadata")
        if isinstance(metadata, dict) and metadata.get("name"):
            return str(metadata["name"])

        source = manifest.get("source") or {}
        if source.get("name"):
            return str(source["name"])

        return listing.name

    def _target_skill_json(
        self,
        skill_snapshot: dict[str, Any],
        *,
        target_name: str,
        target_namespace: str,
    ) -> dict[str, Any]:
        skill_json = deepcopy(skill_snapshot)
        metadata = skill_json.setdefault("metadata", {})
        metadata["name"] = target_name
        metadata["namespace"] = target_namespace
        skill_json["kind"] = "Skill"
        return skill_json

    def _source_binary(
        self,
        db: Session,
        manifest: dict[str, Any],
        skill_snapshot: dict[str, Any],
    ) -> SkillBinary | None:
        source = manifest.get("source") or {}
        source_binary_id = source.get("binary_id")
        source_kind_id = source.get("kind_id")
        expected_status = self._snapshot_binary_status(skill_snapshot)

        if source_binary_id is not None:
            if source_kind_id is None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Source Skill binary metadata is incomplete",
                )
            binary = (
                db.query(SkillBinary)
                .filter(
                    SkillBinary.id == source_binary_id,
                    SkillBinary.kind_id == source_kind_id,
                )
                .first()
            )
            if not binary:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Source Skill binary not found",
                )
            self._validate_binary_snapshot(expected_status, binary)
            return binary

        if source_kind_id:
            binary = (
                db.query(SkillBinary)
                .filter(SkillBinary.kind_id == source_kind_id)
                .first()
            )
            if binary:
                self._validate_binary_snapshot(expected_status, binary)
                return binary

        if expected_status:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Source Skill binary not found",
            )
        return None

    def _snapshot_binary_status(
        self,
        skill_snapshot: dict[str, Any],
    ) -> dict[str, Any]:
        snapshot_status = skill_snapshot.get("status")
        if not isinstance(snapshot_status, dict):
            return {}
        return {
            key: snapshot_status[key]
            for key in ("fileHash", "fileSize")
            if key in snapshot_status
        }

    def _validate_binary_snapshot(
        self,
        expected_status: dict[str, Any],
        binary: SkillBinary,
    ) -> None:
        if not expected_status:
            return

        if (
            "fileHash" in expected_status
            and expected_status["fileHash"] != binary.file_hash
        ) or (
            "fileSize" in expected_status
            and expected_status["fileSize"] != binary.file_size
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Source Skill binary does not match manifest snapshot",
            )

    def _available_name(
        self,
        db: Session,
        *,
        user_id: int,
        namespace: str,
        base_name: str,
    ) -> str:
        return _available_kind_name(
            db,
            user_id=user_id,
            kind="Skill",
            namespace=namespace,
            base_name=base_name,
        )


class McpResourceInstaller:
    """Install MCP server templates into user preferences."""

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
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found",
            )

        manifest = version.manifest or {}
        template = deepcopy(manifest.get("server_config_template") or {})
        required_fields = manifest.get("required_fields") or []
        service_id = listing.name
        server_name = manifest.get("server_name") or service_id
        url = str(options.get("url") or "").strip()
        requires_configuration = self._requires_configuration(
            required_fields,
            provided_values={MCP_URL_KEY: url},
        )

        preferences = user_mcp_service.load_preferences(user.preferences)
        mcps = dict(preferences.get(MCP_ROOT_KEY) or {})
        provider = dict(mcps.get(RESOURCE_LIBRARY_MCP_PROVIDER_ID) or {})
        services = dict(provider.get(MCP_SERVICES_KEY) or {})
        service = {
            "enabled": not requires_configuration,
            "source": "resource-library",
            "listing_id": listing.id,
            "version_id": version.id,
            "server_name": server_name,
            "template": template,
        }
        if url and not requires_configuration:
            service[MCP_CREDENTIALS_KEY] = {
                MCP_URL_KEY: (
                    url if is_data_encrypted(url) else encrypt_sensitive_data(url)
                )
            }

        services[service_id] = service
        provider[MCP_SERVICES_KEY] = services
        mcps[RESOURCE_LIBRARY_MCP_PROVIDER_ID] = provider
        preferences[MCP_ROOT_KEY] = mcps
        user.preferences = user_mcp_service.dump_preferences(preferences)
        db.add(user)
        db.flush()

        return ResourceInstallResult(
            installed_kind_id=None,
            installed_reference={
                "provider_id": RESOURCE_LIBRARY_MCP_PROVIDER_ID,
                "service_id": service_id,
                "server_name": server_name,
            },
            requires_configuration=requires_configuration,
        )

    def _requires_configuration(
        self,
        required_fields: list[str],
        *,
        provided_values: dict[str, str],
    ) -> bool:
        return any(
            not provided_values.get(field, "").strip() for field in required_fields
        )
