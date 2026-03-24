# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

from app.models.kind import Kind
from app.services.adapters.bot_kinds import BotKindsService


def test_get_skill_refs_handles_duplicate_group_skill_names_without_crash(mocker):
    service = BotKindsService(Kind)

    query = mocker.Mock()
    query.filter.return_value = query
    query.all.side_effect = [
        [],
        [
            SimpleNamespace(name="dup-skill", id=101, namespace="group-a"),
            SimpleNamespace(name="dup-skill", id=202, namespace="group-a"),
        ],
        [],
    ]

    db = mocker.Mock()
    db.query.return_value = query

    refs = service._get_skill_refs(
        db=db,
        skill_names=["dup-skill"],
        user_id=7,
        namespace="group-a",
    )

    assert "dup-skill" in refs
    assert refs["dup-skill"].namespace == "group-a"
