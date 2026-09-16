# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.services.adapters.team_kinds import team_kinds_service
from tests.utils.agent_resources import create_runnable_wegent_team


def test_team_detail_reuses_complete_bot_response(
    test_db: Session,
    test_user: User,
) -> None:
    team = create_runnable_wegent_team(
        test_db,
        user_id=test_user.id,
        name_prefix="team-detail",
    )
    team_bot_ref = team.json["spec"]["members"][0]["botRef"]
    bot = (
        test_db.query(Kind)
        .filter(
            Kind.kind == "Bot",
            Kind.name == team_bot_ref["name"],
            Kind.namespace == team_bot_ref["namespace"],
            Kind.user_id == test_user.id,
        )
        .one()
    )

    detail = team_kinds_service.get_team_detail(
        test_db,
        team_id=team.id,
        user_id=test_user.id,
    )

    bot_detail = detail["bots"][0]["bot"]
    assert bot_detail["id"] == bot.id
    assert bot_detail["namespace"] == "default"
    assert bot_detail["shell_name"] == bot.json["spec"]["shellRef"]["name"]
    assert bot_detail["shell_type"] == "Chat"
