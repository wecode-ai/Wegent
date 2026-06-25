from unittest.mock import MagicMock, patch

from app.models.kind import Kind
from app.services.task_team_resolver import can_user_use_team


def test_can_user_use_team_allows_team_in_public_group_namespace() -> None:
    db = MagicMock()
    team = Kind(
        id=1,
        user_id=20,
        kind="Team",
        name="group-team",
        namespace="public-group",
        json={"kind": "Team", "metadata": {"name": "group-team"}},
        is_active=True,
    )

    with (
        patch(
            "app.services.readers.groups.groupReader.is_public",
            return_value=True,
        ) as is_public,
        patch(
            "app.services.adapters.task_kinds.helpers._get_accessible_team_ids",
        ) as get_accessible_team_ids,
    ):
        result = can_user_use_team(db, user_id=10, team=team)

    assert result is True
    is_public.assert_called_once_with(db, "public-group")
    get_accessible_team_ids.assert_not_called()
