"""Default-library bindings use real resources, membership and persistence."""

import pytest
from fastapi import HTTPException

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import ResourceMember
from app.schemas.bot import BotCreate, BotUpdate
from app.services.adapters.bot_kinds import BotKindsService
from app.services.external_entity_resolver import register_entity_resolver
from app.services.share.namespace_entity_resolver import NamespaceEntityResolver
from tests.permission_fixtures import permission_subject  # noqa: F401


@pytest.fixture
def bindings(test_db, permission_subject):
    viewer, ids, _, _ = permission_subject
    register_entity_resolver("namespace", NamespaceEntityResolver)
    group = Namespace(name="platform", owner_user_id=1, is_active=True)
    org = Namespace(
        name="company", owner_user_id=1, level="organization", is_active=True
    )
    test_db.add_all([group, org])
    test_db.flush()
    test_db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=group.id,
            entity_type="user",
            entity_id=str(viewer.id),
            role="Developer",
            status="approved",
        )
    )
    libraries = [test_db.get(Kind, kb_id) for kb_id in ids[:4]]
    test_db.query(ResourceMember).filter(
        ResourceMember.resource_type == "KnowledgeBase",
        ResourceMember.resource_id.in_(ids),
    ).delete(synchronize_session=False)
    for kb in libraries:
        kb.user_id = viewer.id
    libraries[1].namespace = group.name
    libraries[2].namespace = org.name
    libraries[3].user_id = 1
    test_db.add(
        ResourceMember(
            resource_type="KnowledgeBase",
            resource_id=libraries[3].id,
            entity_type="namespace",
            entity_id=str(group.id),
            role="Reporter",
            status="approved",
        )
    )
    shell = Kind(
        kind="Shell",
        name="binding-shell",
        namespace="default",
        user_id=0,
        is_active=True,
        json={
            "metadata": {"name": "binding-shell", "namespace": "default"},
            "spec": {"shellType": "Chat"},
        },
    )
    test_db.add(shell)
    test_db.flush()
    return viewer, libraries, shell


def create_bot(db, viewer, shell, refs=None, namespace="default", name="kb-bot"):
    return BotKindsService(Kind).create_with_user(
        db,
        user_id=viewer.id,
        obj_in=BotCreate(
            name=name,
            shell_name=shell.name,
            agent_config={},
            namespace=namespace,
            default_knowledge_base_refs=refs,
        ),
    )


def test_bot_create_schema_preserves_default_knowledge_base_refs():
    payload = BotCreate(
        name="kb-bot",
        shell_name="ClaudeCode",
        agent_config={"bind_model": "gpt-4.1", "bind_model_type": "public"},
        default_knowledge_base_refs=[{"id": 101, "name": "Product Docs"}],
    )
    assert payload.model_dump()["default_knowledge_base_refs"] == [
        {"id": 101, "name": "Product Docs"}
    ]


def test_default_knowledge_base_binding_requires_direct_access(test_db, bindings):
    viewer, libraries, shell = bindings
    kb = libraries[0]
    test_db.add(
        ResourceMember(
            resource_type="KnowledgeBase",
            resource_id=kb.id,
            entity_type="user",
            entity_id=str(viewer.id),
            role="RestrictedAnalyst",
            status="approved",
        )
    )
    test_db.flush()
    with pytest.raises(HTTPException, match="not directly accessible") as failure:
        create_bot(test_db, viewer, shell, [{"id": kb.id, "name": "Hidden Docs"}])
    assert failure.value.status_code == 400


def test_create_with_user_writes_default_knowledge_bases_into_ghost_spec(
    test_db, bindings
):
    viewer, libraries, shell = bindings
    refs = [{"id": libraries[0].id, "name": "Product Docs"}]
    result = create_bot(test_db, viewer, shell, refs)
    ghost = (
        test_db.query(Kind)
        .filter_by(
            kind="Ghost", name="kb-bot-ghost", user_id=viewer.id, namespace="default"
        )
        .one()
    )
    assert ghost.json["spec"]["defaultKnowledgeBaseRefs"] == refs
    assert result["default_knowledge_base_refs"] == refs


def test_update_with_user_writes_default_knowledge_bases_into_ghost_spec(
    test_db, bindings
):
    viewer, libraries, shell = bindings
    result = create_bot(test_db, viewer, shell)
    refs = [{"id": libraries[0].id, "name": "Product Docs"}]
    updated = BotKindsService(Kind).update_with_user(
        test_db,
        bot_id=result["id"],
        obj_in=BotUpdate(default_knowledge_base_refs=refs),
        user_id=viewer.id,
    )
    ghost = (
        test_db.query(Kind)
        .filter_by(
            kind="Ghost", name="kb-bot-ghost", user_id=viewer.id, namespace="default"
        )
        .one()
    )
    assert ghost.json["spec"]["defaultKnowledgeBaseRefs"] == refs
    assert updated["default_knowledge_base_refs"] == refs


@pytest.mark.parametrize("operation", ["create", "update"])
def test_group_bots_reject_non_group_knowledge_bases(test_db, bindings, operation):
    viewer, libraries, shell = bindings
    refs = [{"id": libraries[0].id, "name": "Personal Docs"}]
    with pytest.raises(HTTPException) as failure:
        if operation == "create":
            create_bot(test_db, viewer, shell, refs, namespace="platform")
        else:
            result = create_bot(test_db, viewer, shell, namespace="platform")
            BotKindsService(Kind).update_with_user(
                test_db,
                bot_id=result["id"],
                obj_in=BotUpdate(default_knowledge_base_refs=refs),
                user_id=viewer.id,
            )
    assert failure.value.status_code == 400
    assert "current group or the organization" in failure.value.detail


@pytest.mark.parametrize("source", [1, 2, 3])
def test_group_bot_accepts_native_organization_and_shared_into_group(
    test_db, bindings, source
):
    viewer, libraries, shell = bindings
    refs = [{"id": libraries[source].id, "name": "Allowed Docs"}]
    result = create_bot(test_db, viewer, shell, refs, namespace="platform")
    assert result["default_knowledge_base_refs"] == refs


@pytest.mark.parametrize("known_grant", [False, True])
def test_independent_department_facts_do_not_expand_every_role_combination(
    test_db, bindings, permission_subject, known_grant, record_property
):
    import cProfile

    viewer, _, shell = bindings
    permission_subject[2].return_value = None
    refs = []
    for index in range(12):
        library = Kind(
            kind="KnowledgeBase",
            namespace="default",
            name=f"cost-{index}",
            user_id=1,
            is_active=True,
            json={"spec": {"name": f"Cost {index}", "directAccessRequirement": "read"}},
        )
        test_db.add(library)
        test_db.flush()
        test_db.add(
            ResourceMember(
                resource_type="KnowledgeBase",
                resource_id=library.id,
                entity_type="directory_group",
                entity_id=f"independent-{index}",
                role="Maintainer",
                status="approved",
            )
        )
        if known_grant:
            test_db.add(
                ResourceMember(
                    resource_type="KnowledgeBase",
                    resource_id=library.id,
                    entity_type="user",
                    entity_id=str(viewer.id),
                    role="Developer",
                    status="approved",
                )
            )
        refs.append({"id": library.id, "name": f"Cost {index}"})
    test_db.flush()
    profile = cProfile.Profile()
    with profile:
        if known_grant:
            result = create_bot(test_db, viewer, shell, refs)
            assert result["default_knowledge_base_refs"] == refs
        else:
            with pytest.raises(HTTPException) as failure:
                create_bot(test_db, viewer, shell, refs)
            assert failure.value.status_code == 503
    calls = sum(
        stat.callcount
        for stat in profile.getstats()
        if getattr(stat.code, "co_name", "") == "resolve_direct_access_decision"
    )
    record_property("action_evaluations", calls)
    assert calls <= 100
    assert permission_subject[2].call_count == 1


def test_direct_access_denial_keeps_priority_over_group_placement(test_db, bindings):
    viewer, libraries, shell = bindings
    test_db.add(
        ResourceMember(
            resource_type="KnowledgeBase",
            resource_id=libraries[1].id,
            entity_type="user",
            entity_id=str(viewer.id),
            role="RestrictedAnalyst",
            status="approved",
        )
    )
    test_db.flush()
    refs = [{"id": kb.id, "name": "Selected"} for kb in libraries[:2]]
    with pytest.raises(HTTPException) as failure:
        create_bot(test_db, viewer, shell, refs, namespace="platform")
    assert failure.value.status_code == 400
    assert failure.value.detail == "Default knowledge bases are not directly accessible"
