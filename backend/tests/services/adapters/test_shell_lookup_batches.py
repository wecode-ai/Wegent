# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shell batches preserve database comparisons and share reads across owners."""

from collections.abc import Generator

import pytest
from sqlalchemy import MetaData, String, create_engine, event
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.services.adapters.shell_utils import (
    get_shell_by_name,
    get_shells_by_names_batch,
    get_shells_by_owners_batch,
)
from app.services.adapters.task_kinds.task_detail_helpers import get_bots_for_subtasks


@pytest.fixture
def shell_db() -> Generator[Session, None, None]:
    """Use isolated in-memory tables with case-insensitive database name matching."""
    metadata = MetaData()
    kinds = Kind.__table__.to_metadata(metadata)
    kinds.c.name.type = String(100, collation="NOCASE")
    kinds.c.namespace.type = String(100, collation="NOCASE")
    Namespace.__table__.to_metadata(metadata)
    ResourceMember.__table__.to_metadata(metadata)
    engine = create_engine("sqlite://")
    metadata.create_all(engine)
    try:
        with Session(engine) as db:
            yield db
    finally:
        engine.dispose()


def _shell(db: Session, owner: int, name: str, namespace: str = "default") -> Kind:
    shell = Kind(user_id=owner, kind="Shell", name=name, namespace=namespace, json={})
    db.add(shell)
    db.flush()
    return shell


def _group(db: Session, owner: int, name: str) -> Namespace:
    group = Namespace(name=name, owner_user_id=owner)
    db.add(group)
    db.flush()
    db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=group.id,
            entity_type="user",
            entity_id=str(owner),
            role="Developer",
            status=MemberStatus.APPROVED.value,
        )
    )
    db.flush()
    return group


def _reference(db: Session, shell: Kind, owner: int) -> None:
    db.add(
        ResourceMember(
            resource_type="Shell",
            resource_id=shell.id,
            entity_type="user",
            entity_id=str(owner),
            role="Reporter",
            status=MemberStatus.APPROVED.value,
        )
    )
    db.flush()


@pytest.mark.parametrize("scope", ["personal", "group", "public"])
def test_batch_retains_requested_name_under_database_collation(shell_db, scope):
    """Personal, authorized group and public reads match the single resolver."""
    owner = 11
    namespace = "default"
    shell_owner = owner
    if scope == "group":
        namespace = _group(shell_db, owner, "nested/group").name
        shell_owner = 12
    elif scope == "public":
        shell_owner = 0
    shell = _shell(shell_db, shell_owner, "Custom-Shell", namespace)
    requested = ("custom-shell", namespace)

    single = get_shell_by_name(shell_db, requested[0], owner, namespace)
    by_names = get_shells_by_names_batch(shell_db, {requested}, owner)
    by_owners = get_shells_by_owners_batch(shell_db, {(owner, *requested)})

    assert single is not None and single.id == shell.id
    assert set(by_names) == {requested}
    assert by_names[requested].id == single.id
    assert set(by_owners) == {(owner, *requested)}
    assert by_owners[(owner, *requested)].id == single.id


def test_collation_matched_owner_shell_precedes_exact_reference(shell_db):
    """An exact-name approved reference must not displace the owner's SQL match."""
    direct = _shell(shell_db, 11, "Custom-Shell")
    referenced = _shell(shell_db, 12, "custom-shell", "source")
    _reference(shell_db, referenced, 11)

    single = get_shell_by_name(shell_db, "custom-shell", 11)
    result = get_shells_by_owners_batch(shell_db, {(11, "custom-shell", "default")})

    assert single is not None and single.id == direct.id
    assert result[(11, "custom-shell", "default")].id == single.id


def test_batch_retains_requested_namespace_under_database_collation(shell_db):
    """A personal SQL match retains the requested namespace as well as its name."""
    shell = _shell(shell_db, 11, "Custom-Shell", "source/group")
    key = (11, "custom-shell", "SOURCE/GROUP")

    single = get_shell_by_name(shell_db, key[1], key[0], key[2])
    result = get_shells_by_owners_batch(shell_db, {key})

    assert single is not None and single.id == shell.id
    assert set(result) == {key}
    assert result[key].id == single.id


def test_multiple_group_matches_keep_first_shell(shell_db):
    """When SQL matches several rows, batching preserves the single lookup's order."""
    group = _group(shell_db, 11, "group")
    first = _shell(shell_db, 12, "Custom-Shell", group.name)
    _shell(shell_db, 13, "custom-shell", group.name)
    key = (11, "custom-shell", group.name)

    single = get_shell_by_name(shell_db, key[1], key[0], key[2])
    result = get_shells_by_owners_batch(shell_db, {key})

    assert single is not None and single.id == first.id
    assert result[key].id == single.id


def test_many_owners_share_public_shell_reads(shell_db):
    """A public-only page must not repeat the same Shell queries for each owner."""
    shell = _shell(shell_db, 0, "shared-shell")
    statements = []

    def capture(_conn, _cursor, statement, _params, _context, _many):
        statements.append(statement)

    event.listen(shell_db.bind, "before_cursor_execute", capture)
    try:
        one = get_shells_by_owners_batch(shell_db, {(11, shell.name, "default")})
        one_owner_queries = len(statements)
        statements.clear()
        keys = {(owner, shell.name, "default") for owner in range(11, 43)}
        many = get_shells_by_owners_batch(shell_db, keys)
    finally:
        event.remove(shell_db.bind, "before_cursor_execute", capture)

    assert one[(11, shell.name, "default")].id == shell.id
    assert set(many) == keys
    assert {item.id for item in many.values()} == {shell.id}
    assert len(statements) == one_owner_queries
    assert len(statements) <= 3


def test_large_owner_batch_preserves_all_requested_keys(shell_db):
    """Request identities survive the shared lookup's parameter batch boundary."""
    shell = _shell(shell_db, 0, "Custom-Shell")
    keys = {(owner, "custom-shell", "default") for owner in range(11, 140)}

    result = get_shells_by_owners_batch(shell_db, keys)

    assert set(result) == keys
    assert {item.id for item in result.values()} == {shell.id}


def test_recovered_group_bot_summaries_keep_collation_matches_and_shared_public_read(
    shell_db,
):
    """Task recovery consumes the requested keys and shares public reads across owners."""
    group = _group(shell_db, 11, "shared-group")
    for owner, namespace, shell_type in [
        (11, group.name, "Codex"),
        (0, "default", "ClaudeCode"),
    ]:
        shell = _shell(shell_db, owner, "Custom-Shell", namespace)
        shell.json = {
            "kind": "Shell",
            "metadata": {"name": shell.name, "namespace": namespace},
            "spec": {"shellType": shell_type, "supportModel": []},
        }
    bots = []
    for owner in [11, 12, 13]:
        bot = Kind(
            user_id=owner,
            kind="Bot",
            name=f"bot-{owner}",
            namespace=group.name,
            json={
                "kind": "Bot",
                "metadata": {"name": f"bot-{owner}", "namespace": group.name},
                "spec": {
                    "ghostRef": {"name": f"ghost-{owner}", "namespace": group.name},
                    "shellRef": {"name": "custom-shell", "namespace": group.name},
                },
            },
        )
        shell_db.add(bot)
        bots.append(bot)
    shell_db.flush()
    public_reads = []

    def capture(_conn, _cursor, statement, _params, _context, _many):
        if "kinds.user_id = ?" in statement and "kinds.namespace = ?" in statement:
            public_reads.append(statement)

    event.listen(shell_db.bind, "before_cursor_execute", capture)
    try:
        summaries = get_bots_for_subtasks(shell_db, {bot.id for bot in bots})
    finally:
        event.remove(shell_db.bind, "before_cursor_execute", capture)

    assert [summaries[bot.id]["shell_type"] for bot in bots] == [
        "Codex",
        "ClaudeCode",
        "ClaudeCode",
    ]
    assert len(public_reads) == 1
