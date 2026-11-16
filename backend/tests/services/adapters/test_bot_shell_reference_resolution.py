# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest
from sqlalchemy import event

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.schemas.bot import BotUpdate
from app.services.adapters.bot_kinds import BotKindsService
from app.services.adapters.task_kinds.task_detail_helpers import get_bots_for_subtasks
from app.services.adapters.team_kinds import team_kinds_service


def _create_group(test_db, user, name: str) -> Namespace:
    """Create a group namespace and make the user a developer."""
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


def _create_shell(
    test_db,
    user,
    namespace: str,
    *,
    name: str = "group-claude",
    shell_type: str = "ClaudeCode",
    owner_user_id: int | None = None,
) -> Kind:
    """Create a Shell resource owned by the requested user."""
    owner_id = user.id if owner_user_id is None else owner_user_id
    shell = Kind(
        user_id=owner_id,
        kind="Shell",
        name=name,
        namespace=namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Shell",
            "metadata": {
                "name": name,
                "namespace": namespace,
                "labels": {"type": "local_engine"},
            },
            "spec": {
                "shellType": shell_type,
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
    """Reference a Shell into a group namespace."""
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


def _reference_shell_to_user(test_db, shell: Kind, user_id: int) -> None:
    """Reference a Shell into a user's personal namespace."""
    test_db.add(
        ResourceMember(
            resource_type="Shell",
            resource_id=shell.id,
            entity_type="user",
            entity_id=str(user_id),
            role="Reporter",
            status=MemberStatus.APPROVED.value,
        )
    )
    test_db.commit()


def _create_bot(
    test_db,
    user,
    namespace: str,
    shell_namespace: str,
    name: str = "group-bot",
    shell_name: str = "group-claude",
) -> Kind:
    """Create a Bot pointing at a Shell reference namespace."""
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
                    "name": shell_name,
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


def _create_team(test_db, user, bot: Kind) -> Kind:
    """Create a Team whose summary includes the supplied Bot."""
    team = Kind(
        user_id=user.id,
        kind="Team",
        name=f"{bot.name}-team",
        namespace=bot.namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {
                "name": f"{bot.name}-team",
                "namespace": bot.namespace,
            },
            "spec": {
                "collaborationModel": "solo",
                "members": [{"botRef": {"name": bot.name, "namespace": bot.namespace}}],
            },
        },
        is_active=True,
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)
    return team


def _assert_team_and_subtask_shell(
    test_db, user, team: Kind, bot: Kind, shell_type: str
) -> None:
    """Check the direct, batched, and task-sync consumers of a Shell reference."""
    detail = team_kinds_service.get_by_id_and_user(
        test_db, team_id=team.id, user_id=user.id
    )
    listed = next(
        item
        for item in team_kinds_service.get_user_teams(
            test_db,
            user_id=user.id,
            scope="personal" if team.namespace == "default" else "group",
            group_name=team.namespace,
        )
        if item["id"] == team.id
    )
    subtask_bots = get_bots_for_subtasks(test_db, {bot.id})

    expected_agent_type = (
        "claude" if shell_type == "ClaudeCode" else shell_type.lower() or None
    )
    assert detail["bots"][0]["bot"]["shell_type"] == shell_type
    assert listed["bots"][0]["bot"]["shell_type"] == shell_type
    assert subtask_bots[bot.id]["shell_type"] == shell_type
    assert detail["agent_type"] == expected_agent_type
    assert listed["agent_type"] == expected_agent_type


@pytest.fixture
def referenced_shell_bot(test_db, test_user):
    """Create a Bot whose Shell is visible through another group's reference."""
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


@pytest.mark.parametrize("competing_group_shell", [False, True])
def test_team_and_subtask_summaries_resolve_referenced_shell(
    test_db, test_user, referenced_shell_bot, competing_group_shell
):
    """All summary consumers must follow the execution lookup precedence."""
    bot, shell, _source_group = referenced_shell_bot
    if competing_group_shell:
        _create_shell(
            test_db,
            test_user,
            bot.json["spec"]["shellRef"]["namespace"],
            name=shell.name,
            shell_type="Codex",
            owner_user_id=test_user.id + 1,
        )
    team = _create_team(test_db, test_user, bot)

    _assert_team_and_subtask_shell(test_db, test_user, team, bot, "ClaudeCode")


def test_summary_reads_follow_source_changes_and_reference_removal(
    test_db, test_user, referenced_shell_bot
):
    """Request-local caches must not retain a changed or removed reference."""
    bot, shell, _source_group = referenced_shell_bot
    team = _create_team(test_db, test_user, bot)
    _assert_team_and_subtask_shell(test_db, test_user, team, bot, "ClaudeCode")

    shell.json = {**shell.json, "spec": {**shell.json["spec"], "shellType": "Codex"}}
    test_db.commit()
    _assert_team_and_subtask_shell(test_db, test_user, team, bot, "Codex")

    test_db.query(ResourceMember).filter(
        ResourceMember.resource_type == "Shell",
        ResourceMember.resource_id == shell.id,
    ).delete()
    test_db.commit()
    _assert_team_and_subtask_shell(test_db, test_user, team, bot, "")


@pytest.mark.parametrize("shell_type,public", [("ClaudeCode", False), ("Chat", True)])
def test_summary_reads_preserve_direct_and_public_shells(
    test_db, test_user, shell_type, public
):
    """Direct custom executors and the public Chat Shell retain their types."""
    shell = _create_shell(
        test_db,
        test_user,
        "default",
        name="custom-shell-name",
        shell_type=shell_type,
        owner_user_id=0 if public else test_user.id,
    )
    bot = _create_bot(
        test_db,
        test_user,
        namespace="default",
        shell_namespace="default",
        shell_name=shell.name,
    )
    team = _create_team(test_db, test_user, bot)

    _assert_team_and_subtask_shell(test_db, test_user, team, bot, shell_type)


@pytest.mark.parametrize("shell_type", ["ClaudeCode", "Chat"])
def test_public_team_summary_uses_system_shell_context(test_db, test_user, shell_type):
    """Public Teams retain the system context even with a viewer-owned namesake."""
    shell = _create_shell(
        test_db,
        test_user,
        "default",
        name="public-team-shell",
        shell_type=shell_type,
        owner_user_id=0,
    )
    _create_shell(
        test_db,
        test_user,
        "default",
        name=shell.name,
        shell_type="Codex",
    )
    public_owner = SimpleNamespace(id=0)
    bot = _create_bot(
        test_db,
        public_owner,
        namespace="default",
        shell_namespace="default",
        shell_name=shell.name,
    )
    team = _create_team(test_db, public_owner, bot)

    _assert_team_and_subtask_shell(test_db, test_user, team, bot, shell_type)


def test_summary_reads_use_each_bot_owners_personal_references(test_db, test_user):
    """Identical personal reference keys belonging to two owners stay distinct."""
    group = _create_group(test_db, test_user, "shared-owner-summary-group")
    bots = []
    for owner_id, shell_type in [
        (test_user.id, "Codex"),
        (test_user.id + 1, "ClaudeCode"),
    ]:
        shell = _create_shell(
            test_db,
            test_user,
            f"source-{owner_id}",
            name="shared-shell",
            shell_type=shell_type,
            owner_user_id=owner_id,
        )
        _reference_shell_to_user(test_db, shell, owner_id)
        bot = _create_bot(
            test_db,
            SimpleNamespace(id=owner_id),
            namespace=group.name,
            shell_namespace="default",
            name=f"bot-{owner_id}",
            shell_name=shell.name,
        )
        team = _create_team(test_db, test_user, bot)
        _assert_team_and_subtask_shell(test_db, test_user, team, bot, shell_type)
        bots.append(bot)

    summaries = get_bots_for_subtasks(test_db, {bot.id for bot in bots})
    assert summaries[bots[0].id]["shell_type"] == "Codex"
    assert summaries[bots[1].id]["shell_type"] == "ClaudeCode"


def test_subtask_shell_resolution_batches_distinct_references(
    test_db, test_user, referenced_shell_bot
):
    """More Shell names for the same owner must not add per-Bot queries."""
    bot, shell, source_group = referenced_shell_bot
    reference_group = (
        test_db.query(Namespace)
        .filter(Namespace.name == bot.json["spec"]["shellRef"]["namespace"])
        .one()
    )
    bot_ids = {bot.id}
    for index in range(2):
        extra_shell = _create_shell(
            test_db, test_user, source_group, name=f"{shell.name}-{index}"
        )
        _reference_shell(test_db, extra_shell, reference_group)
        extra_bot = _create_bot(
            test_db,
            test_user,
            namespace=source_group,
            shell_namespace=reference_group.name,
            shell_name=extra_shell.name,
            name=f"extra-bot-{index}",
        )
        bot_ids.add(extra_bot.id)

    statements = []

    def capture(_conn, _cursor, statement, _params, _context, _many):
        statements.append(statement)

    event.listen(test_db.bind, "before_cursor_execute", capture)
    try:
        get_bots_for_subtasks(test_db, {bot.id})
        single_bot_queries = len(statements)
        statements.clear()
        summaries = get_bots_for_subtasks(test_db, bot_ids)
    finally:
        event.remove(test_db.bind, "before_cursor_execute", capture)

    assert {summary["shell_type"] for summary in summaries.values()} == {"ClaudeCode"}
    assert set(summaries) == bot_ids
    assert len(statements) == single_bot_queries


def test_bot_detail_resolves_shell_by_reference_namespace(
    test_db, test_user, referenced_shell_bot
):
    """Bot detail should resolve a Shell through its reference namespace."""
    bot, _shell, _source_group = referenced_shell_bot

    result = BotKindsService(Kind).get_by_id_and_user(
        test_db, bot_id=bot.id, user_id=test_user.id
    )

    assert result["shell_name"] == "group-claude"
    assert result["shell_type"] == "ClaudeCode"


def test_bot_update_preserves_existing_shell_namespace(
    test_db, test_user, referenced_shell_bot
):
    """A prompt-only update must preserve an existing resolvable Shell namespace."""
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
    """Batch Bot listing should resolve referenced Shells."""
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


@pytest.mark.parametrize("shell_namespace", ["default", "owner-shells"])
def test_shared_bot_prompt_save_uses_owner_shell_identity(
    test_db, test_user, shell_namespace
):
    """A collaborator saving a prompt must not retarget the owner's Shell."""
    group = _create_group(test_db, test_user, "collaborative-bots")
    owner = SimpleNamespace(id=test_user.id + 1)
    if shell_namespace != "default":
        _create_group(test_db, owner, shell_namespace)
    owner_shell = _create_shell(
        test_db,
        owner,
        "owner-source" if shell_namespace == "default" else shell_namespace,
        name="shared-shell",
        shell_type="ClaudeCode",
    )
    if shell_namespace == "default":
        _reference_shell_to_user(test_db, owner_shell, owner.id)
    _create_shell(
        test_db,
        test_user,
        "default",
        name="shared-shell",
        shell_type="Codex",
        owner_user_id=0,
    )
    bot = _create_bot(
        test_db,
        owner,
        namespace=group.name,
        shell_namespace=shell_namespace,
        name="collaborative-bot",
        shell_name="shared-shell",
    )
    service = BotKindsService(Kind)
    before = service.get_by_id_and_user(test_db, bot_id=bot.id, user_id=test_user.id)
    assert before["shell_type"] == "ClaudeCode"

    saved = service.update_with_user(
        test_db,
        bot_id=bot.id,
        obj_in=BotUpdate(shell_name="shared-shell", system_prompt="updated prompt"),
        user_id=test_user.id,
    )

    test_db.expire_all()
    persisted = test_db.get(Kind, bot.id)
    assert persisted.json["spec"]["shellRef"]["namespace"] == shell_namespace
    assert saved["shell_type"] == before["shell_type"]
    after = service.get_by_id_and_user(test_db, bot_id=bot.id, user_id=test_user.id)
    assert after["shell_type"] == before["shell_type"]


def test_detail_and_list_share_reference_precedence(
    test_db, test_user, referenced_shell_bot
):
    """Detail and list lookups should choose the same Shell source."""
    bot, _shell, source_group = referenced_shell_bot
    _create_shell(
        test_db,
        test_user,
        "aaa-reference",
        name="group-claude",
        shell_type="Codex",
        owner_user_id=test_user.id + 1,
    )

    detail = BotKindsService(Kind).get_by_id_and_user(
        test_db, bot_id=bot.id, user_id=test_user.id
    )
    listed = next(
        item
        for item in BotKindsService(Kind).get_user_bots(
            test_db,
            user_id=test_user.id,
            scope="group",
            group_name=source_group,
            limit=100,
        )
        if item["id"] == bot.id
    )

    assert detail["shell_type"] == "ClaudeCode"
    assert listed["shell_type"] == detail["shell_type"]


def test_bot_update_keeps_shell_type_for_referenced_shell(
    test_db, test_user, referenced_shell_bot
):
    """Bot update responses should retain the referenced Shell type."""
    bot, shell, _source_group = referenced_shell_bot
    existing_namespace = bot.json["spec"]["shellRef"]["namespace"]

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
    refreshed = test_db.get(Kind, bot.id)
    assert refreshed.json["spec"]["shellRef"]["namespace"] == existing_namespace


def test_bot_update_replaces_obsolete_group_reference_public_fallback(
    test_db, test_user, referenced_shell_bot
):
    """An obsolete group reference should fall back to the public namespace."""
    bot, shell, _source_group = referenced_shell_bot
    source_shell = test_db.get(Kind, shell.id)
    source_shell.is_active = False
    test_db.query(ResourceMember).filter(
        ResourceMember.resource_type == "Shell",
        ResourceMember.resource_id == shell.id,
    ).delete()
    _create_shell(
        test_db,
        test_user,
        "default",
        name="group-claude",
        shell_type="Codex",
        owner_user_id=0,
    )
    test_db.commit()

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
    assert result["shell_type"] == "Codex"
    assert refreshed.json["spec"]["shellRef"]["namespace"] == "default"


def test_bot_list_uses_bot_owner_reference_identity(test_db, test_user):
    """Batch list resolution should use the Bot owner's reference identity."""
    group = _create_group(test_db, test_user, "shared-owner-group")
    owner_id = test_user.id + 1
    owner_shell = _create_shell(
        test_db,
        test_user,
        "owner-source",
        name="shared-shell",
        shell_type="ClaudeCode",
        owner_user_id=owner_id,
    )
    viewer_shell = _create_shell(
        test_db,
        test_user,
        "viewer-source",
        name="shared-shell",
        shell_type="Codex",
        owner_user_id=test_user.id,
    )
    _reference_shell_to_user(test_db, owner_shell, owner_id)
    _reference_shell_to_user(test_db, viewer_shell, test_user.id)
    bot = _create_bot(
        test_db,
        SimpleNamespace(id=owner_id),
        namespace=group.name,
        shell_namespace="default",
        name="shared-default-bot",
        shell_name="shared-shell",
    )

    listed = next(
        item
        for item in BotKindsService(Kind).get_user_bots(
            test_db,
            user_id=test_user.id,
            scope="group",
            group_name=group.name,
            limit=100,
        )
        if item["id"] == bot.id
    )

    assert listed["shell_type"] == "ClaudeCode"
