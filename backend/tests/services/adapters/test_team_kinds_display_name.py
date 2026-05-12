# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.models.kind import Kind
from app.schemas.team import TeamUpdate
from app.services.adapters.team_kinds import team_kinds_service


def _create_team_kind(db, user_id: int) -> Kind:
    team = Kind(
        user_id=user_id,
        kind="Team",
        name="dev-team",
        namespace="default",
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "dev-team", "namespace": "default"},
            "spec": {"members": [], "collaborationModel": "pipeline"},
            "status": {"state": "Available"},
        },
    )
    db.add(team)
    db.commit()
    db.refresh(team)
    return team


def test_update_team_persists_display_name_in_metadata(test_db, test_user):
    team = _create_team_kind(test_db, test_user.id)

    result = team_kinds_service.update_with_user(
        test_db,
        team_id=team.id,
        obj_in=TeamUpdate(displayName="Spec Dev Team"),
        user_id=test_user.id,
    )

    test_db.refresh(team)
    assert result["displayName"] == "Spec Dev Team"
    assert team.json["metadata"]["displayName"] == "Spec Dev Team"
