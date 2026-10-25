"""Resource authorization writes retain identity, history and atomicity."""

from datetime import datetime

from app.models.resource_member import ResourceMember
from app.schemas.base_role import BaseRole
from app.services.workspaces.storage import ensure_resource_grant


def test_cp11_grant_restoration_preserves_history_and_outer_transaction(test_db):
    requested_at = datetime(2025, 1, 2, 3, 4, 5)
    original = ResourceMember.create(
        resource_type="Team",
        resource_id=101,
        entity_type="workspace",
        entity_id="11",
        role="Reporter",
        status="rejected",
        invited_by_user_id=2,
        requested_at=requested_at,
        reviewed_by_user_id=3,
        reviewed_at=requested_at,
        share_link_id=7,
    )
    test_db.add(original)
    test_db.commit()
    grant_id = original.id

    restored = ensure_resource_grant(
        test_db,
        workspace_id=11,
        resource_type="Team",
        resource_id=101,
        added_by_user_id=1,
        role=BaseRole.Developer,
    )
    assert restored is original and restored.id == grant_id
    assert (restored.role, restored.status, restored.invited_by_user_id) == (
        "Developer",
        "approved",
        1,
    )
    assert restored.requested_at == restored.reviewed_at == requested_at
    assert restored.reviewed_by_user_id == 3 and restored.share_link_id == 7
    assert restored.user_id == 0
    assert test_db.query(ResourceMember).filter_by(resource_id=101).count() == 1

    test_db.rollback()
    test_db.refresh(original)
    assert (original.role, original.status, original.invited_by_user_id) == (
        "Reporter",
        "rejected",
        2,
    )
