# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json

import pytest
from fastapi import HTTPException

from app.models.kind import Kind
from app.models.resource_library import ResourceLibraryListing, ResourceLibraryVersion
from app.models.skill_binary import SkillBinary
from app.services.resource_library.installers import (
    McpResourceInstaller,
    SkillResourceInstaller,
)
from app.services.user_mcp_service import user_mcp_service


def _create_skill_kind(
    test_db,
    *,
    user_id: int,
    name: str = "doc-summary",
    namespace: str = "default",
    description: str = "Summarize docs",
) -> Kind:
    skill = Kind(
        user_id=user_id,
        kind="Skill",
        name=name,
        namespace=namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Skill",
            "metadata": {
                "name": name,
                "namespace": namespace,
                "displayName": "Doc Summary",
            },
            "spec": {"description": description},
        },
        is_active=True,
    )
    test_db.add(skill)
    test_db.commit()
    test_db.refresh(skill)
    return skill


def _create_skill_listing_and_version(
    test_db,
    *,
    test_user,
    source_skill: Kind,
    source_binary: SkillBinary | None = None,
    snapshot_name: str | None = None,
    snapshot_status: dict | None = None,
) -> tuple[ResourceLibraryListing, ResourceLibraryVersion]:
    skill_snapshot = {
        **source_skill.json,
        "metadata": {
            **source_skill.json["metadata"],
            "name": snapshot_name or source_skill.name,
            "namespace": source_skill.namespace,
        },
    }
    if snapshot_status is not None:
        skill_snapshot["status"] = snapshot_status

    listing = ResourceLibraryListing(
        resource_type="skill",
        name=source_skill.name,
        display_name="Doc Summary",
        publisher_user_id=test_user.id,
        status="published",
        tags=[],
    )
    test_db.add(listing)
    test_db.commit()
    test_db.refresh(listing)

    version = ResourceLibraryVersion(
        listing_id=listing.id,
        version="1.0.0",
        manifest={
            "resource_type": "skill",
            "skill": skill_snapshot,
            "source": {
                "kind_id": source_skill.id,
                "binary_id": source_binary.id if source_binary else None,
                "namespace": source_skill.namespace,
                "name": source_skill.name,
            },
        },
        source_kind_id=source_skill.id,
        source_binary_id=source_binary.id if source_binary else None,
        is_current=True,
    )
    test_db.add(version)
    test_db.commit()
    test_db.refresh(version)
    return listing, version


def _remove_manifest_skill_snapshot(
    test_db,
    version: ResourceLibraryVersion,
) -> ResourceLibraryVersion:
    manifest = dict(version.manifest)
    manifest.pop("skill", None)
    version.manifest = manifest
    test_db.add(version)
    test_db.commit()
    test_db.refresh(version)
    return version


def _create_skill_binary(test_db, *, source_skill: Kind) -> SkillBinary:
    binary = SkillBinary(
        kind_id=source_skill.id,
        binary_data=b"zip-content",
        file_size=len(b"zip-content"),
        file_hash="hash",
    )
    test_db.add(binary)
    test_db.commit()
    test_db.refresh(binary)
    return binary


def _create_mcp_listing_and_version(
    test_db,
    *,
    test_user,
) -> tuple[ResourceLibraryListing, ResourceLibraryVersion]:
    listing = ResourceLibraryListing(
        resource_type="mcp",
        name="docs-mcp",
        display_name="Docs MCP",
        publisher_user_id=test_user.id,
        status="published",
        tags=[],
    )
    test_db.add(listing)
    test_db.commit()
    test_db.refresh(listing)

    version = ResourceLibraryVersion(
        listing_id=listing.id,
        version="1.0.0",
        manifest={
            "resource_type": "mcp",
            "server_name": "docs",
            "server_config_template": {
                "type": "streamable-http",
                "url": "",
            },
            "required_fields": ["url"],
        },
        is_current=True,
    )
    test_db.add(version)
    test_db.commit()
    test_db.refresh(version)
    return listing, version


def test_skill_installer_copies_kind_and_binary(test_db, test_user):
    source_skill = _create_skill_kind(test_db, user_id=test_user.id)
    source_binary = _create_skill_binary(test_db, source_skill=source_skill)
    listing, version = _create_skill_listing_and_version(
        test_db,
        test_user=test_user,
        source_skill=source_skill,
        source_binary=source_binary,
        snapshot_name="snapshot-name",
        snapshot_status={
            "fileHash": source_binary.file_hash,
            "fileSize": source_binary.file_size,
        },
    )

    result = SkillResourceInstaller().install(
        db=test_db,
        user_id=test_user.id,
        listing=listing,
        version=version,
        target_namespace="team-a",
        options={"manifest": {"metadata": {"name": "client-name"}}},
    )

    copied = test_db.get(Kind, result.installed_kind_id)
    copied_binary = (
        test_db.query(SkillBinary)
        .filter(SkillBinary.kind_id == result.installed_kind_id)
        .one()
    )
    assert copied.kind == "Skill"
    assert copied.name == "snapshot-name"
    assert copied.namespace == "team-a"
    assert copied.user_id == test_user.id
    assert copied.json["metadata"]["name"] == "snapshot-name"
    assert copied.json["metadata"]["namespace"] == "team-a"
    assert copied.json["spec"]["description"] == "Summarize docs"
    assert copied.json["status"] == {
        "fileHash": source_binary.file_hash,
        "fileSize": source_binary.file_size,
    }
    assert copied_binary.binary_data == b"zip-content"
    assert copied_binary.file_size == len(b"zip-content")
    assert copied_binary.file_hash == "hash"
    assert result.installed_reference == {
        "skill_id": copied.id,
        "namespace": "team-a",
        "name": "snapshot-name",
    }


def test_skill_installer_fails_without_manifest_skill_snapshot(test_db, test_user):
    source_skill = _create_skill_kind(
        test_db,
        user_id=test_user.id,
        description="Live source must not be used",
    )
    listing, version = _create_skill_listing_and_version(
        test_db,
        test_user=test_user,
        source_skill=source_skill,
    )
    _remove_manifest_skill_snapshot(test_db, version)

    with pytest.raises(HTTPException) as exc_info:
        SkillResourceInstaller().install(
            db=test_db,
            user_id=test_user.id,
            listing=listing,
            version=version,
            target_namespace="team-a",
            options={},
        )

    assert exc_info.value.status_code in {400, 404}
    assert test_db.query(Kind).filter(Kind.namespace == "team-a").count() == 0


def test_skill_installer_fails_when_manifest_binary_id_missing(test_db, test_user):
    source_skill = _create_skill_kind(test_db, user_id=test_user.id)
    fallback_binary = _create_skill_binary(test_db, source_skill=source_skill)
    listing, version = _create_skill_listing_and_version(
        test_db,
        test_user=test_user,
        source_skill=source_skill,
        source_binary=fallback_binary,
    )
    manifest = dict(version.manifest)
    manifest["source"] = {
        **manifest["source"],
        "binary_id": fallback_binary.id + 1000,
    }
    version.manifest = manifest
    test_db.add(version)
    test_db.commit()
    test_db.refresh(version)

    with pytest.raises(HTTPException) as exc_info:
        SkillResourceInstaller().install(
            db=test_db,
            user_id=test_user.id,
            listing=listing,
            version=version,
            target_namespace="team-a",
            options={},
        )

    assert exc_info.value.status_code in {400, 404}
    assert test_db.query(Kind).filter(Kind.namespace == "team-a").count() == 0


def test_skill_installer_fails_when_snapshot_binary_metadata_mismatches(
    test_db,
    test_user,
):
    source_skill = _create_skill_kind(test_db, user_id=test_user.id)
    source_binary = _create_skill_binary(test_db, source_skill=source_skill)
    listing, version = _create_skill_listing_and_version(
        test_db,
        test_user=test_user,
        source_skill=source_skill,
        source_binary=source_binary,
        snapshot_status={
            "fileHash": "old-hash",
            "fileSize": source_binary.file_size + 1,
        },
    )

    with pytest.raises(HTTPException) as exc_info:
        SkillResourceInstaller().install(
            db=test_db,
            user_id=test_user.id,
            listing=listing,
            version=version,
            target_namespace="team-a",
            options={},
        )

    assert exc_info.value.status_code in {400, 404}
    assert test_db.query(Kind).filter(Kind.namespace == "team-a").count() == 0


def test_skill_installer_generates_available_name_for_duplicate_install(
    test_db,
    test_user,
):
    source_skill = _create_skill_kind(test_db, user_id=test_user.id)
    listing, version = _create_skill_listing_and_version(
        test_db,
        test_user=test_user,
        source_skill=source_skill,
    )

    first = SkillResourceInstaller().install(
        db=test_db,
        user_id=test_user.id,
        listing=listing,
        version=version,
        target_namespace="default",
        options={},
    )
    second = SkillResourceInstaller().install(
        db=test_db,
        user_id=test_user.id,
        listing=listing,
        version=version,
        target_namespace="default",
        options={},
    )

    first_skill = test_db.get(Kind, first.installed_kind_id)
    second_skill = test_db.get(Kind, second.installed_kind_id)
    assert first_skill.name == "doc-summary-2"
    assert second_skill.name == "doc-summary-3"
    assert second_skill.json["metadata"]["name"] == "doc-summary-3"
    assert second_skill.json["metadata"]["namespace"] == "default"


def test_mcp_installer_writes_user_config_with_url(test_db, test_user):
    listing, version = _create_mcp_listing_and_version(test_db, test_user=test_user)

    result = McpResourceInstaller().install(
        db=test_db,
        user_id=test_user.id,
        listing=listing,
        version=version,
        target_namespace="default",
        options={"url": "https://example.com/mcp"},
    )

    test_db.refresh(test_user)
    config = user_mcp_service.get_provider_service_config(
        test_user.preferences,
        "resource-library",
        "docs-mcp",
    )
    raw_preferences = json.loads(test_user.preferences)
    service = raw_preferences["mcps"]["resource-library"]["services"]["docs-mcp"]
    assert result.requires_configuration is False
    assert result.installed_reference == {
        "provider_id": "resource-library",
        "service_id": "docs-mcp",
        "server_name": "docs",
    }
    assert config == {"enabled": True, "url": "https://example.com/mcp"}
    assert service["server_name"] == "docs"
    assert service["template"] == {
        "type": "streamable-http",
        "url": "",
    }
    assert service["listing_id"] == listing.id
    assert service["version_id"] == version.id


def test_mcp_installer_requires_configuration_without_url(test_db, test_user):
    listing, version = _create_mcp_listing_and_version(test_db, test_user=test_user)

    result = McpResourceInstaller().install(
        db=test_db,
        user_id=test_user.id,
        listing=listing,
        version=version,
        target_namespace="default",
        options={},
    )

    test_db.refresh(test_user)
    config = user_mcp_service.get_provider_service_config(
        test_user.preferences,
        "resource-library",
        "docs-mcp",
    )
    assert result.requires_configuration is True
    assert config == {"enabled": False, "url": ""}
    assert (
        "credentials"
        not in json.loads(test_user.preferences)["mcps"]["resource-library"][
            "services"
        ]["docs-mcp"]
    )
