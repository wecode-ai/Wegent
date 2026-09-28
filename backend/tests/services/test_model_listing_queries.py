import pytest
from sqlalchemy import event

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.services.capability_reference_service import (
    list_referenced_capabilities_by_namespace,
)
from app.services.model_aggregation_service import model_aggregation_service
from app.services.model_listing_queries import load_direct_models_by_namespace


def make_model(db, owner, name, namespace="default", *, active=True, category="llm"):
    model = Kind(
        kind="Model",
        user_id=owner,
        name=name,
        namespace=namespace,
        is_active=active,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {"name": name, "namespace": namespace},
            "spec": {
                "modelType": category,
                "modelConfig": {"env": {"model": "openai", "model_id": name}},
            },
        },
    )
    db.add(model)
    db.flush()
    return model


def reference(db, source, target_type, target_id, *, status="approved", kind="Model"):
    db.add(
        ResourceMember.create(
            resource_type=kind,
            resource_id=source.id,
            entity_type=target_type,
            entity_id=str(target_id),
            role="Reporter",
            status=status,
            invited_by_user_id=source.user_id,
        )
    )
    db.flush()


def test_batch_references_preserve_target_scope_and_approved_active_sources(
    test_db, test_user
):
    uid = test_user.id
    groups = [
        Namespace(name=name, owner_user_id=uid, is_active=name != "inactive")
        for name in ["visible", "hidden", "inactive"]
    ]
    test_db.add_all(groups)
    test_db.flush()
    personal = make_model(test_db, uid + 1, "personal-ref")
    shared = make_model(test_db, uid + 1, "group-ref")
    reference(test_db, personal, "user", uid)
    reference(test_db, shared, "namespace", groups[0].id)
    # A source referenced into two targets must stay visible in both.
    reference(test_db, shared, "user", uid)
    for name, owner, active, target_type, target_id, status, kind in [
        ("other-user", uid + 1, True, "user", uid + 1, "approved", "Model"),
        ("hidden", uid + 1, True, "namespace", groups[1].id, "approved", "Model"),
        (
            "inactive-target",
            uid + 1,
            True,
            "namespace",
            groups[2].id,
            "approved",
            "Model",
        ),
        ("inactive-source", uid + 1, False, "user", uid, "approved", "Model"),
        ("system", 0, True, "user", uid, "approved", "Model"),
        ("pending", uid + 1, True, "user", uid, MemberStatus.PENDING.value, "Model"),
        ("wrong-kind", uid + 1, True, "user", uid, "approved", "Shell"),
    ]:
        source = make_model(test_db, owner, name, active=active)
        reference(test_db, source, target_type, target_id, status=status, kind=kind)

    result = list_referenced_capabilities_by_namespace(
        test_db,
        kind="Model",
        user_id=uid,
        namespaces=["default", "visible", "inactive", "missing"],
    )

    assert {key: [model.name for model in value] for key, value in result.items()} == {
        "default": ["personal-ref", "group-ref"],
        "visible": ["group-ref"],
        "inactive": [],
        "missing": [],
    }


@pytest.mark.parametrize("group_count", [1, 41])
def test_query_count_is_constant_as_namespace_count_grows(
    test_db, test_user, group_count
):
    uid = test_user.id
    groups = [
        Namespace(name=f"group-{index}", owner_user_id=uid, is_active=True)
        for index in range(group_count)
    ]
    test_db.add_all(groups)
    test_db.flush()
    for group in groups:
        make_model(test_db, uid, "direct", group.name)
    source = make_model(test_db, uid + 1, "reference")
    reference(test_db, source, "namespace", groups[-1].id)
    names = [group.name for group in groups]
    statements = []

    def record(_conn, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement)

    bind = test_db.get_bind()
    event.listen(bind, "before_cursor_execute", record)
    try:
        direct = load_direct_models_by_namespace(test_db, user_id=uid, namespaces=names)
        refs = list_referenced_capabilities_by_namespace(
            test_db, kind="Model", user_id=uid, namespaces=names
        )
    finally:
        event.remove(bind, "before_cursor_execute", record)

    assert len(statements) == 3
    assert all(len(direct[name]) == 1 for name in names)
    assert refs[names[-1]] == [source]
    assert all(not refs[name] for name in names[:-1])


def test_listing_keeps_group_order_direct_precedence_and_category_filter(
    test_db, test_user, monkeypatch
):
    uid = test_user.id
    groups = [Namespace(name=name, owner_user_id=uid) for name in ["first", "second"]]
    test_db.add_all(groups)
    test_db.flush()
    first = make_model(test_db, uid, "same-name", "first")
    make_model(test_db, uid, "same-name", "second")
    make_model(test_db, uid, "excluded", "hidden")
    make_model(test_db, uid, "inactive", "first", active=False)
    direct = make_model(test_db, uid, "direct-wins", "first")
    shared = make_model(test_db, uid + 1, "direct-wins", category="embedding")
    reference(test_db, shared, "namespace", groups[0].id)
    monkeypatch.setattr(
        "app.services.group_permission.get_user_groups", lambda *a: ["first", "second"]
    )
    monkeypatch.setattr(
        "app.services.model_aggregation_service.public_model_service.get_models",
        lambda **kw: [],
    )

    listed = model_aggregation_service.list_available_models(
        test_db, test_user, scope="group"
    )
    filtered = model_aggregation_service.list_available_models(
        test_db, test_user, scope="group", model_category_type="embedding"
    )

    assert {item["name"] for item in listed} == {first.name, direct.name}
    assert all(item["namespace"] == "first" for item in listed)
    assert all(not item["isReference"] for item in listed)
    assert filtered == []
