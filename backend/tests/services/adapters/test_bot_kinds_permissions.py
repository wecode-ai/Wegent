# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.schemas.base_role import BaseRole
from app.schemas.bot import BotUpdate
from app.services.adapters.bot_kinds import bot_kinds_service


def _create_bot(db, *, user_id: int, namespace: str = "default") -> Kind:
    bot = Kind(
        user_id=user_id,
        kind="Bot",
        name="secured-bot",
        namespace=namespace,
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Bot",
            "metadata": {"name": "secured-bot", "namespace": namespace},
            "spec": {
                "ghostRef": {"name": "secured-bot-ghost", "namespace": namespace},
                "shellRef": {"name": "ClaudeCode", "namespace": "default"},
            },
            "status": {"state": "Available"},
        },
    )
    db.add(bot)
    db.commit()
    db.refresh(bot)
    return bot


def _add_group_member(db, *, namespace: Namespace, user_id: int, role: BaseRole):
    member = ResourceMember(
        resource_type="Namespace",
        resource_id=namespace.id,
        entity_type="user",
        entity_id=str(user_id),
        user_id=user_id,
        role=role.value,
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=namespace.owner_user_id,
        reviewed_by_user_id=namespace.owner_user_id,
    )
    db.add(member)
    db.commit()
    return member


def test_personal_bot_rejects_non_owner_access(
    test_db,
    test_user,
    test_admin_user,
):
    bot = _create_bot(test_db, user_id=test_admin_user.id)

    protected_calls = (
        lambda: bot_kinds_service.get_bot_detail(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
        ),
        lambda: bot_kinds_service.update_with_user(
            test_db,
            bot_id=bot.id,
            obj_in=BotUpdate(name="hijacked"),
            user_id=test_user.id,
        ),
        lambda: bot_kinds_service.check_running_tasks(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
        ),
        lambda: bot_kinds_service.delete_with_user(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
            force=True,
        ),
    )

    for call in protected_calls:
        with pytest.raises(HTTPException) as exc_info:
            call()
        assert exc_info.value.status_code == 403

    test_db.refresh(bot)
    assert bot.name == "secured-bot"
    assert bot.is_active is True


def test_group_reporter_cannot_access_bot_configuration(
    test_db,
    test_user,
    test_admin_user,
):
    namespace = Namespace(
        name="bot-security",
        display_name="Bot Security",
        owner_user_id=test_admin_user.id,
        visibility="private",
        level="group",
        is_active=True,
    )
    test_db.add(namespace)
    test_db.commit()
    test_db.refresh(namespace)
    _add_group_member(
        test_db,
        namespace=namespace,
        user_id=test_user.id,
        role=BaseRole.Reporter,
    )
    bot = _create_bot(
        test_db,
        user_id=test_admin_user.id,
        namespace=namespace.name,
    )

    with pytest.raises(HTTPException) as exc_info:
        bot_kinds_service.get_bot_detail(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
        )
    assert exc_info.value.status_code == 403

    with pytest.raises(HTTPException) as exc_info:
        bot_kinds_service.update_with_user(
            test_db,
            bot_id=bot.id,
            obj_in=BotUpdate(name="hijacked"),
            user_id=test_user.id,
        )
    assert exc_info.value.status_code == 403

    with pytest.raises(HTTPException) as exc_info:
        bot_kinds_service.delete_with_user(
            test_db,
            bot_id=bot.id,
            user_id=test_user.id,
            force=True,
        )
    assert exc_info.value.status_code == 403


def test_group_developer_can_read_and_update_bot(
    test_db,
    test_user,
    test_admin_user,
):
    namespace = Namespace(
        name="bot-developers",
        display_name="Bot Developers",
        owner_user_id=test_admin_user.id,
        visibility="private",
        level="group",
        is_active=True,
    )
    test_db.add(namespace)
    test_db.commit()
    test_db.refresh(namespace)
    _add_group_member(
        test_db,
        namespace=namespace,
        user_id=test_user.id,
        role=BaseRole.Developer,
    )
    bot = _create_bot(
        test_db,
        user_id=test_admin_user.id,
        namespace=namespace.name,
    )

    with patch.object(
        bot_kinds_service,
        "_get_bot_components",
        return_value=(None, None, None),
    ):
        with patch.object(
            bot_kinds_service,
            "_convert_to_bot_dict",
            return_value={"id": bot.id},
        ):
            result = bot_kinds_service.get_bot_detail(
                test_db,
                bot_id=bot.id,
                user_id=test_user.id,
            )
            updated = bot_kinds_service.update_with_user(
                test_db,
                bot_id=bot.id,
                obj_in=BotUpdate(),
                user_id=test_user.id,
            )

    assert result["id"] == bot.id
    assert updated["id"] == bot.id
