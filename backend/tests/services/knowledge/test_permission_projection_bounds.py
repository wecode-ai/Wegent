"""Equivalent unknown shares must not multiply role-only permission states."""

import pytest

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import ResourceMember
from app.services.external_entity_resolver import entity_resolution_scope
from app.services.knowledge.knowledge_access_policy import (
    default_knowledge_base_binding_error,
    resolve_direct_access_decision,
)
from app.services.knowledge.permission_context import (
    build_knowledge_permission_context,
    permission_scenarios,
)
from tests.permission_fixtures import permission_subject  # noqa: F401


@pytest.fixture
def unknown_shares(test_db, permission_subject):
    viewer, ids, directory, _ = permission_subject
    directory.return_value = None
    library = test_db.get(Kind, ids[1])
    for index in range(6):
        group = Namespace(
            name=f"external-share-{index}",
            owner_user_id=library.user_id,
            is_active=True,
        )
        test_db.add(group)
        test_db.flush()
        for resource_type, resource_id, entity_type, entity_id in (
            ("Namespace", group.id, "directory_group", f"external-{index}"),
            ("KnowledgeBase", library.id, "namespace", str(group.id)),
        ):
            test_db.add(
                ResourceMember(
                    resource_type=resource_type,
                    resource_id=resource_id,
                    entity_type=entity_type,
                    entity_id=entity_id,
                    role="Reporter",
                    status="approved",
                )
            )
    test_db.flush()
    return viewer, library


def test_equivalent_unknown_shares_have_only_two_read_projections(
    test_db, unknown_shares
):
    viewer, library = unknown_shares
    with entity_resolution_scope(test_db):
        facts = build_knowledge_permission_context(
            test_db, [library], viewer.id, frozenset()
        )
        scenarios = list(permission_scenarios(test_db, library, facts))
        decisions = {
            resolve_direct_access_decision(
                test_db, library, viewer.id, context=scenario
            )
            for scenario in scenarios
        }
    assert decisions == {False, True}
    assert len(scenarios) == 2


def test_owner_default_binding_never_enumerates_unknown_shares(
    test_db, unknown_shares, monkeypatch
):
    viewer, library = unknown_shares
    library.user_id = viewer.id
    test_db.flush()

    def unexpected_projection(*args, **kwargs):
        raise AssertionError(
            "An already determined owner action needs no state product"
        )

    monkeypatch.setattr(
        "app.services.knowledge.permission_context.permission_scenarios",
        unexpected_projection,
    )
    assert (
        default_knowledge_base_binding_error(
            test_db, [library.id], viewer.id, "default"
        )
        is None
    )
