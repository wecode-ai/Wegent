"""List work grows by candidates without repeating database or directory reads."""

from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from app.services.knowledge.knowledge_service import KnowledgeService
from tests.permission_fixtures import permission_subject, sql_count  # noqa: F401


def test_list_query_count_is_constant_for_two_and_one_hundred_libraries(
    test_db, permission_subject
):
    viewer, ids, directory, _ = permission_subject
    test_db.query(Kind).filter(Kind.id.in_(ids)).update({"is_active": False})
    counts = []
    for start, size in ((0, 2), (2, 100)):
        for index in range(start, size):
            library = Kind(
                kind="KnowledgeBase",
                name=f"batched-{index}",
                namespace="default",
                user_id=1,
                is_active=True,
                json={
                    "spec": {
                        "name": f"batched-{index}",
                        "directAccessRequirement": "read",
                    }
                },
            )
            test_db.add(library)
            test_db.flush()
            test_db.add(
                ResourceMember(
                    resource_type="KnowledgeBase",
                    resource_id=library.id,
                    entity_type="directory_group",
                    entity_id="D0",
                    role="Reporter",
                    status="approved",
                )
            )
        test_db.flush()
        directory.reset_mock()
        with sql_count(test_db) as statements:
            rows, total = KnowledgeService.list_knowledge_bases_paginated(
                test_db, viewer.id, limit=100
            )
        assert total == size
        assert len(rows) == size
        assert directory.call_count == 1
        counts.append(len(statements))
    assert counts[0] == counts[1]
