# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.schemas.bot import BotUpdate
from app.services.adapters.bot_kinds import BotKindsService


def _create_group(test_db, user, name: str) -> Namespace:
    namespace = Namespace(
        name=name,
        display_name=name,
        owner_user_id=user.id,
        visibility="private",
        description="",
        level="group",
        is_active=True,
    )
    test_db.add(namespace)
    test_db.flush()
    test_db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=namespace.id,
            entity_type="user",
            entity_id=str(user.id),
            role="Developer",
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=user.id,
            reviewed_by_user_id=user.id,
        )
    )
    test_db.commit()
    test_db.refresh(namespace)
    return namespace


def _create_shell(test_db, user, namespace: str) -> Kind:
    shell = Kind(
        user_id=user.id,
        kind="Shell",
        name="group-claude",
        namespace=namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Shell",
            "metadata": {
                "name": "group-claude",
                "namespace": namespace,
                "labels": {"type": "local_engine"},
            },
            "spec": {
                "shellType": "ClaudeCode",
                "supportModel": [],
                "baseImage": "example.invalid/executor:test",
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    test_db.add(shell)
    test_db.commit()
    test_db.refresh(shell)
    return shell


def _reference_shell(test_db, shell: Kind, namespace: Namespace) -> None:
    test_db.add(
        ResourceMember(
            resource_type="Shell",
            resource_id=shell.id,
            entity_type="namespace",
            entity_id=str(namespace.id),
            entity_display_name=namespace.name,
            role="Reporter",
            status=MemberStatus.APPROVED.value,
        )
    )
    test_db.commit()


def _create_bot(
    test_db, user, namespace: str, shell_namespace: str, name: str = "group-bot"
) -> Kind:
    bot = Kind(
        user_id=user.id,
        kind="Bot",
        name=name,
        namespace=namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Bot",
            "metadata": {"name": name, "namespace": namespace},
            "spec": {
                "ghostRef": {"name": f"{name}-ghost", "namespace": namespace},
                "shellRef": {
                    "name": "group-claude",
                    "namespace": shell_namespace,
                },
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    test_db.add(bot)
    test_db.commit()
    test_db.refresh(bot)
    return bot


@pytest.fixture
def referenced_shell_bot(test_db, test_user):
    reference_group = _create_group(test_db, test_user, "aaa-reference")
    source_group = _create_group(test_db, test_user, "zzz-source")
    shell = _create_shell(test_db, test_user, source_group.name)
    _reference_shell(test_db, shell, reference_group)
    bot = _create_bot(
        test_db,
        test_user,
        namespace=source_group.name,
        shell_namespace=reference_group.name,
    )
    return bot, shell, source_group.name


def test_bot_detail_resolves_shell_by_reference_namespace(
    test_db, test_user, referenced_shell_bot
):
    bot, _shell, _source_group = referenced_shell_bot

    result = BotKindsService(Kind).get_by_id_and_user(
        test_db, bot_id=bot.id, user_id=test_user.id
    )

    assert result["shell_name"] == "group-claude"
    assert result["shell_type"] == "ClaudeCode"


def test_bot_update_preserves_existing_shell_namespace(
    test_db, test_user, referenced_shell_bot
):
    _bot, shell, source_group = referenced_shell_bot
    bot = _create_bot(
        test_db,
        test_user,
        namespace=source_group,
        shell_namespace=source_group,
        name="direct-shell-bot",
    )

    result = BotKindsService(Kind).update_with_user(
        test_db,
        bot_id=bot.id,
        obj_in=BotUpdate(
            name=bot.name,
            shell_name=shell.name,
            system_prompt="updated prompt",
        ),
        user_id=test_user.id,
    )

    refreshed = test_db.get(Kind, bot.id)
    assert result["shell_type"] == "ClaudeCode"
    assert refreshed.json["spec"]["shellRef"]["namespace"] == source_group


def test_bot_list_resolves_referenced_shells_in_batch(
    test_db, test_user, referenced_shell_bot
):
    bot, _shell, source_group = referenced_shell_bot

    result = BotKindsService(Kind).get_user_bots(
        test_db,
        user_id=test_user.id,
        scope="group",
        group_name=source_group,
        limit=100,
    )

    listed = next(item for item in result if item["id"] == bot.id)
    assert listed["shell_name"] == "group-claude"
    assert listed["shell_type"] == "ClaudeCode"


def test_bot_update_keeps_shell_type_for_referenced_shell(
    test_db, test_user, referenced_shell_bot
):
    bot, shell, _source_group = referenced_shell_bot

    result = BotKindsService(Kind).update_with_user(
        test_db,
        bot_id=bot.id,
        obj_in=BotUpdate(
            name=bot.name,
            shell_name=shell.name,
            system_prompt="updated prompt",
        ),
        user_id=test_user.id,
    )

    assert result["shell_name"] == "group-claude"
    assert result["shell_type"] == "ClaudeCode"
