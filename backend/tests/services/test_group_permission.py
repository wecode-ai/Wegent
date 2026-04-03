# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from sqlalchemy.orm import Session

from app.schemas.namespace import GroupRole
from app.services.group_permission import get_view_role_in_group


@pytest.mark.unit
def test_get_view_role_in_group_returns_effective_membership_role(
    test_db: Session,
) -> None:
    role = get_view_role_in_group(
        test_db,
        user_id=1,
        group_name="team-alpha",
        role_resolver=lambda db, user_id, group_name: GroupRole.Developer,
    )

    assert role == GroupRole.Developer


@pytest.mark.unit
def test_get_view_role_in_group_treats_admin_as_owner_for_organization_namespace(
    test_db: Session,
) -> None:
    role = get_view_role_in_group(
        test_db,
        user_id=1,
        group_name="organization-space",
        user_role="admin",
        group_level="organization",
        role_resolver=lambda db, user_id, group_name: None,
    )

    assert role == GroupRole.Owner


@pytest.mark.unit
def test_get_view_role_in_group_does_not_elevate_admin_for_regular_group(
    test_db: Session,
) -> None:
    role = get_view_role_in_group(
        test_db,
        user_id=1,
        group_name="regular-group",
        user_role="admin",
        group_level="group",
        role_resolver=lambda db, user_id, group_name: None,
    )

    assert role is None
