"""External-directory test double for public permission contracts."""

from contextlib import contextmanager
from datetime import datetime
from unittest.mock import Mock

import pytest
from sqlalchemy import event

from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.models.user import User
from app.services import external_entity_resolver as entities


@pytest.fixture
def permission_subject(test_db, test_user, monkeypatch):
    directory = Mock(return_value=frozenset({"D0", "D2", "D3"}))

    class DirectoryResolver(entities.IExternalEntityResolver):
        def match_entity_bindings(
            self, db, user_id, entity_type, entity_ids, user_context=None
        ):
            from app.services.execution_permission_scope import (
                is_execution_resource_scope,
            )

            if is_execution_resource_scope():
                return []
            with entities.entity_resolution_scope(db):
                context = entities.get_entity_resolution_context(db)
                key = f"test-directory:{user_id}"
                if key not in context.facts:
                    try:
                        context.facts[key] = directory(user_id)
                    except RuntimeError:
                        context.facts[key] = None
                snapshot = context.facts[key]
                if snapshot is None:
                    raise entities.EntityMembershipUnavailable(entity_ids, [])
                return [eid for eid in entity_ids if eid in snapshot]

        def get_resource_ids_by_entity(
            self,
            db,
            user_id,
            entity_type,
            resource_type="KnowledgeBase",
            user_context=None,
        ):
            rows = (
                db.query(ResourceMember.entity_id)
                .filter(
                    ResourceMember.entity_type == entity_type,
                    ResourceMember.resource_type == resource_type,
                    ResourceMember.status == "approved",
                )
                .all()
            )
            matched = self.match_entity_bindings(
                db, user_id, entity_type, list({row[0] for row in rows})
            )
            return entities.list_resources_by_entity_match(
                db, resource_type, entity_type, matched
            )

    monkeypatch.setattr(entities, "_external_entity_resolvers", {})
    monkeypatch.setattr(entities, "_resolver_instances", {})
    entities.register_entity_resolver("directory_group", DirectoryResolver)
    from app.services.share.namespace_entity_resolver import NamespaceEntityResolver

    entities.register_entity_resolver("namespace", NamespaceEntityResolver)
    viewer = User(
        user_name="permission-visitor", password_hash="unused", is_active=True
    )
    test_db.add(viewer)
    test_db.flush()
    ids = []
    for index in range(12):
        library = Kind(
            kind="KnowledgeBase",
            name=f"permission-{index}",
            namespace="default",
            user_id=test_user.id,
            is_active=True,
            updated_at=datetime(2026, 1, 1),
            json={
                "spec": {
                    "name": f"permission-{index}",
                    "directAccessRequirement": "read",
                }
            },
        )
        test_db.add(library)
        test_db.flush()
        ids.append(library.id)
        test_db.add(
            ResourceMember(
                resource_type="KnowledgeBase",
                resource_id=library.id,
                entity_type="directory_group",
                entity_id=f"D{index % 4}",
                role="Reporter",
                status="approved",
            )
        )
    test_db.commit()
    return viewer, ids, directory, {}


@contextmanager
def sql_count(db):
    statements = []

    def track(*args):
        statements.append(args[2])

    bind = db.get_bind()
    event.listen(bind, "before_cursor_execute", track)
    try:
        yield statements
    finally:
        event.remove(bind, "before_cursor_execute", track)
