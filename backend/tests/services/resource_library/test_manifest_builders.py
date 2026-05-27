# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from fastapi import HTTPException

from app.models.kind import Kind
from app.models.skill_binary import SkillBinary
from app.services.resource_library.manifest_builders import ResourceManifestBuilder


def _create_kind(
    test_db,
    *,
    user_id: int,
    kind: str,
    name: str,
    namespace: str = "default",
    is_active: bool = True,
) -> Kind:
    source = Kind(
        user_id=user_id,
        kind=kind,
        name=name,
        namespace=namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": kind,
            "metadata": {
                "name": name,
                "namespace": namespace,
                "displayName": name.replace("-", " ").title(),
            },
            "spec": {"description": f"{kind} {name}"},
        },
        is_active=is_active,
    )
    test_db.add(source)
    test_db.commit()
    test_db.refresh(source)
    return source


def test_build_agent_manifest_from_current_user_active_team(test_db, test_user):
    team = _create_kind(
        test_db,
        user_id=test_user.id,
        kind="Team",
        name="research-agent",
    )

    manifest = ResourceManifestBuilder().build(
        db=test_db,
        user_id=test_user.id,
        resource_type="agent",
        source_id=team.id,
        options={},
    )

    assert manifest["resource_type"] == "agent"
    assert manifest["team"]["metadata"]["name"] == "research-agent"
    assert manifest["source"] == {
        "kind_id": team.id,
        "namespace": "default",
        "name": "research-agent",
    }


def test_build_skill_manifest_includes_skill_snapshot_and_binary_id(test_db, test_user):
    skill = _create_kind(
        test_db,
        user_id=test_user.id,
        kind="Skill",
        name="doc-summary",
    )
    binary = SkillBinary(
        kind_id=skill.id,
        binary_data=b"skill zip",
        file_size=9,
        file_hash="hash",
    )
    test_db.add(binary)
    test_db.commit()
    test_db.refresh(binary)

    manifest = ResourceManifestBuilder().build(
        db=test_db,
        user_id=test_user.id,
        resource_type="skill",
        source_id=skill.id,
        options={},
    )

    assert manifest["resource_type"] == "skill"
    assert manifest["skill"]["metadata"]["name"] == "doc-summary"
    assert manifest["source"] == {
        "kind_id": skill.id,
        "binary_id": binary.id,
        "namespace": "default",
        "name": "doc-summary",
    }


def test_build_agent_manifest_rejects_other_user_source(
    test_db,
    test_user,
    test_admin_user,
):
    team = _create_kind(
        test_db,
        user_id=test_admin_user.id,
        kind="Team",
        name="other-agent",
    )

    with pytest.raises(HTTPException) as exc_info:
        ResourceManifestBuilder().build(
            db=test_db,
            user_id=test_user.id,
            resource_type="agent",
            source_id=team.id,
            options={},
        )

    assert exc_info.value.status_code == 404


def test_build_mcp_manifest_drops_secret_values(test_db, test_user):
    manifest = ResourceManifestBuilder().build(
        db=test_db,
        user_id=test_user.id,
        resource_type="mcp",
        source_id=1,
        options={
            "server_name": "docs",
            "server_config": {
                "type": "streamable-http",
                "url": "https://example.com/mcp",
                "headers": {"Authorization": "Bearer secret"},
                "token": "secret",
                "nested": {
                    "api_key": "secret",
                    "safe_value": "public",
                },
            },
        },
    )

    assert manifest["resource_type"] == "mcp"
    assert manifest["server_name"] == "docs"
    assert manifest["server_config_template"] == {
        "type": "streamable-http",
        "url": "",
        "nested": {"safe_value": "public"},
    }
    assert manifest["required_fields"] == ["url"]
