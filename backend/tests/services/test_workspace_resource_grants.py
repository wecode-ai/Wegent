"""Workspace grants preserve authorization and audit metadata during restoration."""

from datetime import datetime

import pytest
from sqlalchemy.orm import Session

from app.models.resource_member import EPOCH_TIME, ResourceMember
from app.schemas.base_role import BaseRole
from app.services.workspaces.storage import ensure_resource_grant


def restore(db: Session) -> ResourceMember:
    return ensure_resource_grant(
        db,
        workspace_id=11,
        resource_type="Team",
        resource_id=101,
        added_by_user_id=7,
        role=BaseRole.Developer,
    )


def test_new_workspace_grant_keeps_resource_member_defaults(test_db: Session) -> None:
    grant = restore(test_db)

    assert grant.user_id == 0
    assert (grant.role, grant.status, grant.invited_by_user_id) == (
        "Developer",
        "approved",
        7,
    )
    assert grant.entity_display_name == ""
    assert (
        grant.share_link_id,
        grant.reviewed_by_user_id,
        grant.copied_resource_id,
    ) == (
        0,
        0,
        0,
    )
    assert grant.reviewed_at == EPOCH_TIME
    assert isinstance(grant.requested_at, datetime)
    assert isinstance(grant.created_at, datetime)
    assert isinstance(grant.updated_at, datetime)


@pytest.mark.parametrize("status", ["pending", "rejected", "approved"])
def test_cp11_restoring_workspace_grant_preserves_its_identity_and_audit_metadata(
    test_db: Session, status: str
) -> None:
    timestamp = datetime(2020, 1, 2, 3, 4, 5)
    existing = ResourceMember.create(
        resource_type="Team",
        resource_id=101,
        entity_type="workspace",
        entity_id="11",
        role="Reporter",
        status=status,
        invited_by_user_id=2,
        entity_display_name="Keep workspace label",
        share_link_id=13,
        reviewed_by_user_id=17,
        reviewed_at=timestamp,
        copied_resource_id=19,
        requested_at=timestamp,
    )
    existing.created_at = timestamp
    test_db.add(existing)
    test_db.flush()

    grant = restore(test_db)

    assert grant is existing
    assert test_db.query(ResourceMember).count() == 1
    assert (grant.role, grant.status, grant.invited_by_user_id) == (
        "Developer",
        "approved",
        7,
    )
    assert grant.entity_display_name == "Keep workspace label"
    assert (
        grant.share_link_id,
        grant.reviewed_by_user_id,
        grant.copied_resource_id,
    ) == (
        13,
        17,
        19,
    )
    assert (grant.reviewed_at, grant.requested_at, grant.created_at) == (timestamp,) * 3


def test_unchanged_workspace_grant_keeps_its_update_timestamp(test_db: Session) -> None:
    grant = restore(test_db)
    timestamp = datetime(2020, 1, 2, 3, 4, 5)
    grant.updated_at = timestamp
    test_db.flush()

    assert restore(test_db) is grant
    assert grant.updated_at == timestamp
