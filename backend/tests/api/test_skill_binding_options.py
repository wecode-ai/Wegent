"""Binding discovery uses the same authorization as Bot persistence."""

import pytest
from sqlalchemy import event

from app.core.security import create_access_token
from app.models.resource_member import ResourceMember
from tests.api.test_skills_api import TestSkillsAPI as _SkillApiHelpers
from tests.api.test_skills_api import (
    _add_group_member,
    _create_group,
    _create_user,
)
from tests.services.adapters.test_bot_kinds_permissions import _create_bot
from tests.services.test_skill_binding_service import _create_skill


@pytest.mark.api
def test_binding_options_follow_bot_namespace_and_current_group_shares(
    test_client, test_db, test_user, test_token
):
    publisher = _create_user(test_db, "binding-publisher", "binding@example.com")
    publisher_headers = {
        "Authorization": "Bearer "
        + create_access_token(data={"sub": publisher.user_name})
    }
    headers = {"Authorization": f"Bearer {test_token}"}
    groups = [
        _create_group(test_db, test_user, name)
        for name in ("binding-all", "binding-dev")
    ]
    for group in groups:
        for user in (test_user, publisher):
            _add_group_member(test_db, group, user, "Owner")

    def upload(auth, namespace):
        response = test_client.post(
            "/api/v1/kinds/skills/upload",
            headers=auth,
            data={"name": "same-skill", "namespace": namespace},
            files={
                "file": (
                    "same-skill.zip",
                    _SkillApiHelpers.create_test_zip(
                        "---\ndescription: Binding option\n---\nSecret prompt",
                        "same-skill",
                    ),
                    "application/zip",
                )
            },
        )
        assert response.status_code == 201, response.text
        return int(response.json()["metadata"]["labels"]["id"])

    personal_id = upload(headers, "default")
    shared_id = upload(publisher_headers, "default")
    bot = _create_bot(test_db, user_id=test_user.id, namespace=groups[1].name)

    def share(names):
        response = test_client.post(
            f"/api/v1/kinds/skills/{shared_id}/bindings/groups",
            headers=publisher_headers,
            json={"group_names": names},
        )
        assert response.status_code == 200, response.text

    def options(**params):
        response = test_client.get(
            "/api/v1/kinds/skills", headers=headers, params=params
        )
        assert response.status_code == 200, response.text
        items = response.json()["items"]
        assert all(item["spec"]["prompt"] is None for item in items)
        return {int(item["metadata"]["labels"]["id"]) for item in items}

    share([groups[0].name])
    # The browsing namespace cannot override the actual Bot's binding target.
    params = {"binding_bot_id": bot.id, "binding_namespace": groups[0].name}
    assert personal_id in options(**params)
    assert shared_id not in options(**params)
    assert shared_id in options(binding_namespace=groups[0].name)

    share([g.name for g in groups])
    assert {personal_id, shared_id}.issubset(options(**params))

    queries = []
    full_skill_reads = []

    def record_skill_page(_conn, _cursor, statement, parameters, _context, _many):
        if "kinds.json AS kinds_json" in statement and "Skill" in parameters:
            full_skill_reads.append(statement)
        if (
            "kinds.json" in statement
            and "ORDER BY kinds.created_at DESC" in statement
            and "Skill" in parameters
        ):
            queries.append(statement)

    engine = test_db.get_bind()
    event.listen(engine, "before_cursor_execute", record_skill_page)
    try:
        first = options(**params, skip=0, limit=1)
        second = options(**params, skip=1, limit=1)
    finally:
        event.remove(engine, "before_cursor_execute", record_skill_page)
    assert len(first) == len(second) == 1
    assert first.isdisjoint(second)
    assert first | second == {personal_id, shared_id}
    assert len(queries) == 2
    assert all("LIMIT" in statement and "OFFSET" in statement for statement in queries)
    # Permission lookup must not reload complete default Skill definitions per page.
    assert len(full_skill_reads) == 2

    response = test_client.delete(
        f"/api/v1/kinds/skills/{shared_id}/bindings/groups",
        headers=publisher_headers,
        params={"group_name": groups[1].name},
    )
    assert response.status_code == 204
    assert shared_id not in options(**params)
    # Removing one group's authorization also removes multi-target eligibility.
    assert shared_id not in options(
        binding_namespace="default", target_group_names=[g.name for g in groups]
    )

    denied = test_client.get(
        "/api/v1/kinds/skills",
        headers=headers,
        params={"binding_namespace": "unrelated-private-group"},
    )
    assert denied.status_code == 403


@pytest.mark.api
def test_binding_options_require_permission_to_edit_bot(
    test_client, test_db, test_user, test_admin_user, test_token
):
    bot = _create_bot(test_db, user_id=test_admin_user.id)
    response = test_client.get(
        "/api/v1/kinds/skills",
        headers={"Authorization": f"Bearer {test_token}"},
        params={"binding_bot_id": bot.id},
    )
    assert response.status_code == 403


@pytest.mark.api
@pytest.mark.parametrize("namespace", ["binding-space", " binding-space "])
def test_binding_options_use_canonical_namespace(
    test_client, test_db, test_user, test_admin_user, test_token, namespace
):
    group = _create_group(test_db, test_admin_user, "binding-space")
    _add_group_member(test_db, group, test_user, "Reporter")
    skill = _create_skill(test_db, user_id=test_admin_user.id, name="group-option")
    skill.namespace = group.name
    test_db.commit()

    response = test_client.get(
        "/api/v1/kinds/skills",
        headers={"Authorization": f"Bearer {test_token}"},
        params={"binding_namespace": namespace},
    )

    assert response.status_code == 200, response.text
    assert [
        int(item["metadata"]["labels"]["id"]) for item in response.json()["items"]
    ] == [skill.id]


@pytest.mark.api
def test_binding_options_recheck_group_membership_even_for_bot_owner(
    test_client, test_db, test_user, test_admin_user, test_token
):
    group = _create_group(test_db, test_admin_user, "binding-revoked")
    _add_group_member(test_db, group, test_user, "Developer")
    bot = _create_bot(test_db, user_id=test_user.id, namespace=group.name)
    headers = {"Authorization": f"Bearer {test_token}"}
    params = {"binding_bot_id": bot.id}
    assert (
        test_client.get(
            "/api/v1/kinds/skills", headers=headers, params=params
        ).status_code
        == 200
    )

    # Revocation must apply even when the Bot ownership is retained.
    test_db.query(ResourceMember).filter(
        ResourceMember.resource_type == "Namespace",
        ResourceMember.resource_id == group.id,
        ResourceMember.entity_type == "user",
        ResourceMember.entity_id == str(test_user.id),
    ).delete(synchronize_session=False)
    test_db.commit()
    assert bot.user_id == test_user.id

    response = test_client.get("/api/v1/kinds/skills", headers=headers, params=params)
    assert response.status_code == 403
