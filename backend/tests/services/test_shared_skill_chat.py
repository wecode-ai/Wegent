# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared personal Skills must remain usable from a member's personal chat."""

import io
import zipfile
from types import SimpleNamespace

import pytest

from app.api.ws.events import SkillRef
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.services.execution.request_builder import TaskRequestBuilder
from app.services.skill_binding_service import skill_binding_service
from app.services.skill_resolution import find_skill_by_ref
from app.services.task_skill_selection import (
    build_task_skill_labels,
    parse_requested_skill_refs_from_labels,
)
from shared.models.execution import ExecutionRequest


@pytest.fixture
def shared_skill(test_client, test_db, test_user, test_admin_user, test_token):
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as package:
        package.writestr(
            "shared-analysis/SKILL.md",
            "---\nname: shared-analysis\ndescription: Shared analysis\n---\nAnalyze data.",
        )
    response = test_client.post(
        "/api/v1/kinds/skills/upload",
        headers={"Authorization": f"Bearer {test_token}"},
        data={"name": "shared-analysis", "namespace": "default"},
        files={"file": ("shared-analysis.zip", archive.getvalue(), "application/zip")},
    )
    assert response.status_code == 201, response.text
    skill_id = int(response.json()["metadata"]["labels"]["id"])
    source = test_db.get(Kind, skill_id)
    group = Namespace(
        name="shared-chat-group",
        display_name="Shared chat group",
        owner_user_id=test_user.id,
        visibility="private",
        level="group",
        is_active=True,
    )
    test_db.add(group)
    test_db.flush()
    for user, role in [(test_user, "Owner"), (test_admin_user, "Reporter")]:
        test_db.add(
            ResourceMember(
                resource_type="Namespace",
                resource_id=group.id,
                entity_type="user",
                entity_id=str(user.id),
                role=role,
                status=MemberStatus.APPROVED.value,
                invited_by_user_id=test_user.id,
                share_link_id=0,
                reviewed_by_user_id=test_user.id,
                copied_resource_id=0,
            )
        )
    test_db.commit()
    binding = skill_binding_service.add_group_skill(
        test_db,
        group_namespace=group.name,
        skill_id=source.id,
        created_by=test_user.id,
    )
    return source, binding, archive.getvalue()


def test_member_selection_preserves_shared_skill_identity(
    shared_skill, test_client, test_db, test_admin_user, test_admin_token
):
    source, _, _ = shared_skill
    response = test_client.get(
        "/api/v1/kinds/skills/unified?scope=all",
        headers={"Authorization": f"Bearer {test_admin_token}"},
    )
    assert response.status_code == 200
    listed = next(item for item in response.json() if item["id"] == source.id)
    assert listed["is_group_shared"] is True
    assert listed["namespace"] == "default"

    selection = SkillRef(
        name=source.name, namespace="default", is_public=False, skill_id=source.id
    )
    saved = parse_requested_skill_refs_from_labels(build_task_skill_labels([selection]))
    assert saved[0].get("skill_id") == source.id
    resolved = TaskRequestBuilder(test_db)._find_skill_by_ref(
        skill_name=selection.name,
        namespace=selection.namespace,
        is_public=selection.is_public,
        user_id=test_admin_user.id,
        team_namespace="default",
        skill_id=saved[0]["skill_id"],
    )
    assert resolved == source


def test_member_can_download_shared_skill_using_source_namespace(
    shared_skill, test_client, test_admin_token
):
    source, _, archive = shared_skill
    response = test_client.get(
        f"/api/v1/kinds/skills/{source.id}/download?namespace=default",
        headers={"Authorization": f"Bearer {test_admin_token}"},
    )
    assert response.status_code == 200
    assert response.content == archive


def test_late_context_resolution_preserves_shared_skill_id(
    shared_skill, test_db, test_admin_user, mocker
):
    source, _, _ = shared_skill
    builder = TaskRequestBuilder(test_db)
    resolve = mocker.patch.object(
        builder, "_get_bot_skills", return_value=([], [], [], {})
    )
    request = ExecutionRequest(
        skill_names=[source.name],
        preload_skills=[source.name, "wegent-knowledge"],
        skill_refs={source.name: {"skill_id": source.id, "namespace": "default"}},
    )
    builder.resolve_request_preload_skills(
        request=request,
        bot=SimpleNamespace(name="chat-bot"),
        team=SimpleNamespace(namespace="default"),
        user=test_admin_user,
    )
    assert resolve.call_args.kwargs["user_preload_skills"][0] == {
        "skill_id": source.id,
        "name": source.name,
        "namespace": "default",
        "is_public": False,
    }


def test_member_resolves_group_owned_skill_in_personal_chat(
    shared_skill, test_db, test_admin_user
):
    source, binding, _ = shared_skill
    source.namespace = binding.namespace
    source.json = {
        **source.json,
        "metadata": {**source.json["metadata"], "namespace": binding.namespace},
    }
    binding.is_active = False
    test_db.commit()

    assert (
        find_skill_by_ref(
            test_db,
            skill_name=source.name,
            namespace=source.namespace,
            is_public=False,
            user_id=test_admin_user.id,
            team_namespace="default",
            skill_id=source.id,
        )
        == source
    )


@pytest.mark.parametrize("revoked", ["binding", "membership", "skill"])
def test_removed_access_revokes_resolution_and_download(
    shared_skill, test_client, test_db, test_admin_user, test_admin_token, revoked
):
    source, binding, _ = shared_skill
    if revoked == "membership":
        membership = (
            test_db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == "Namespace",
                ResourceMember.entity_id == str(test_admin_user.id),
            )
            .one()
        )
        test_db.delete(membership)
    elif revoked == "skill":
        source.is_active = False
    else:
        binding.is_active = False
    test_db.commit()
    assert (
        find_skill_by_ref(
            test_db,
            skill_name=source.name,
            namespace="default",
            is_public=False,
            user_id=test_admin_user.id,
            team_namespace="default",
            skill_id=source.id,
        )
        is None
    )
    response = test_client.get(
        f"/api/v1/kinds/skills/{source.id}/download?namespace=default",
        headers={"Authorization": f"Bearer {test_admin_token}"},
    )
    assert response.status_code == 404
