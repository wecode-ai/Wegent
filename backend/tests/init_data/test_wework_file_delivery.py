# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""The default device agent must use Wegent's actual artifact delivery contract."""

from pathlib import Path

import yaml
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.core.yaml_init import apply_public_resources
from app.models.kind import Kind


def _default_ghost() -> dict:
    path = Path(__file__).parents[2] / "init_data" / "02-public-resources.yaml"
    resources = yaml.safe_load_all(path.read_text(encoding="utf-8"))
    return next(
        resource
        for resource in resources
        if resource
        and resource.get("kind") == "Ghost"
        and resource["metadata"]["namespace"] == "default"
        and resource["metadata"]["name"] == "wegent-wework"
    )


def test_wework_prompt_declares_files_instead_of_inventing_download_links() -> None:
    prompt = _default_ghost()["spec"]["systemPrompt"]

    assert '"$WEGENT_EXECUTOR_BINARY" artifact declare --path' in prompt
    assert "[WEGENT_ARTIFACT]" in prompt
    assert "metadata only" in prompt
    assert "not source files, caches, logs, or intermediate files" in prompt
    assert "Do not invent download URLs" in prompt
    assert "computer://" not in prompt
    assert "mnt/outputs" not in prompt


def test_default_yaml_preserves_an_existing_legacy_public_ghost(
    test_db: Session,
) -> None:
    legacy = (
        Path(__file__).parents[1] / "fixtures/wework_legacy_file_delivery.txt"
    ).read_text(encoding="utf-8")
    payload = _default_ghost()
    payload["spec"]["systemPrompt"] = legacy
    payload["spec"]["skills"] = [{"name": "administrator-preserved"}]
    ghost = Kind(
        user_id=0,
        kind="Ghost",
        name="wegent-wework",
        namespace="default",
        json=payload,
        is_active=True,
    )
    test_db.add(ghost)
    test_db.commit()
    identity = ghost.id
    # Establish the test fixture's savepoint before observing initializer SQL.
    test_db.connection()
    statements: list[str] = []

    def capture(_connection, _cursor, statement, _parameters, _context, _many):
        statements.append(statement.lstrip().upper())

    event.listen(test_db.bind, "before_cursor_execute", capture)
    try:
        result = apply_public_resources(test_db, [_default_ghost()])
    finally:
        event.remove(test_db.bind, "before_cursor_execute", capture)
    test_db.refresh(ghost)
    assert result[0]["operation"] == "skipped"
    assert ghost.id == identity
    assert ghost.json == payload
    assert statements and all(
        statement.startswith("SELECT") for statement in statements
    )
