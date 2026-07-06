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
            SimpleNamespace(
                name="dup-skill",
                id=101,
                namespace="group-a",
                user_id=8,
                json={},
            ),
            SimpleNamespace(
                name="dup-skill",
                id=202,
                namespace="group-a",
                user_id=9,
                json={},
            ),
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


def test_get_skill_refs_includes_skill_content_hash(mocker):
    service = BotKindsService(Kind)

    query = mocker.Mock()
    query.filter.return_value = query
    query.all.side_effect = [
        [
            SimpleNamespace(
                name="test-skill",
                id=259904,
                namespace="default",
                user_id=7,
                json={"status": {"fileHash": "abc123"}},
            )
        ],
    ]

    db = mocker.Mock()
    db.query.return_value = query

    refs = service._get_skill_refs(
        db=db,
        skill_names=["test-skill"],
        user_id=7,
        namespace="default",
    )

    assert refs["test-skill"].content_hash == "sha256:abc123"
