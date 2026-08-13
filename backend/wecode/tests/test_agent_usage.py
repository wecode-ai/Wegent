# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import date, datetime, time, timedelta

from sqlalchemy.orm import Session

from app.models.user import User
from wecode.api.agent_usage import query_usage
from wecode.models.agent_task_usage import AgentTaskUsageDetail
from wecode.schemas.agent_usage import AgentUsageQuery


def test_query_usage_returns_daily_details_for_admin(
    test_db: Session,
    test_admin_user: User,
) -> None:
    first_day = date.today() - timedelta(days=3)
    second_day = first_day + timedelta(days=1)
    test_db.add_all(
        [
            AgentTaskUsageDetail(
                id=101,
                task_id=101,
                visitor_user_id=10,
                agent_name="Agent A",
                agent_namespace="default",
                agent_user_id=test_admin_user.id,
                task_created_at=datetime.combine(first_day, time(hour=9)),
                ai_rounds=3,
                completed_ai_rounds=2,
            ),
            AgentTaskUsageDetail(
                id=102,
                task_id=102,
                visitor_user_id=11,
                agent_name="Agent A",
                agent_namespace="default",
                agent_user_id=test_admin_user.id,
                task_created_at=datetime.combine(first_day, time(hour=10)),
                ai_rounds=4,
                completed_ai_rounds=4,
            ),
            AgentTaskUsageDetail(
                id=103,
                task_id=103,
                visitor_user_id=10,
                agent_name="Agent A",
                agent_namespace="default",
                agent_user_id=test_admin_user.id,
                task_created_at=datetime.combine(second_day, time(hour=9)),
                ai_rounds=2,
                completed_ai_rounds=1,
            ),
            AgentTaskUsageDetail(
                id=104,
                task_id=104,
                visitor_user_id=10,
                agent_name="Agent B",
                agent_namespace="default",
                agent_user_id=test_admin_user.id,
                task_created_at=datetime.combine(second_day, time(hour=11)),
                ai_rounds=1,
                completed_ai_rounds=1,
            ),
        ]
    )
    test_db.commit()

    result = query_usage(
        AgentUsageQuery(start_date=first_day, end_date=second_day),
        test_db,
        test_admin_user,
    )

    assert result.pv == 4
    assert result.uv == 2
    assert [
        (
            row.date,
            row.agent_name,
            row.pv,
            row.uv,
            row.ai_rounds,
            row.completed_ai_rounds,
        )
        for row in result.daily_rows
    ] == [
        (second_day, "Agent A", 1, 1, 2, 1),
        (second_day, "Agent B", 1, 1, 1, 1),
        (first_day, "Agent A", 2, 2, 7, 6),
    ]
