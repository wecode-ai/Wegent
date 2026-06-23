# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.core.system_knowledge_init import run_system_knowledge_initialization
from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.namespace import Namespace
from app.models.user import User
from app.schemas.namespace import GroupLevel

pytestmark = pytest.mark.unit


def _admin_user(test_db) -> User:
    user = User(
        user_name="admin",
        password_hash="hash",
        email="admin@example.com",
        role="admin",
        is_active=True,
        auth_source="password",
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


def _write_seed(root: Path, content: str = "# Quick Start\n\nUse Wegent.") -> Path:
    seed_dir = root / "system_knowledge" / "wegent-help"
    doc_path = seed_dir / "docs" / "en" / "quick-start.md"
    doc_path.parent.mkdir(parents=True)
    doc_path.write_text(content, encoding="utf-8")
    manifest = {
        "seed_id": "wegent-help",
        "knowledge_base": {
            "name": "Wegent Help",
            "display_name": "Wegent 帮助文档",
            "namespace": "system",
            "description": "Built-in Wegent documentation.",
        },
        "documents": [
            {
                "source_path": "docs/en/quick-start.md",
                "seed_path": "docs/en/quick-start.md",
                "language": "en",
                "title": "Quick Start",
                "category": "",
                "content_sha256": "hash-1",
            }
        ],
    }
    (seed_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root


def test_system_knowledge_init_creates_org_namespace_kb_and_document(
    test_db, tmp_path: Path, mocker
) -> None:
    admin = _admin_user(test_db)
    init_dir = _write_seed(tmp_path)
    schedule = mocker.patch(
        "app.core.system_knowledge_init.schedule_document_indexing_if_possible"
    )

    result = run_system_knowledge_initialization(
        db=test_db,
        admin_user_id=admin.id,
        init_data_dir=init_dir,
    )

    assert result["status"] == "completed"
    namespace = test_db.query(Namespace).filter(Namespace.name == "system").one()
    assert namespace.level == GroupLevel.organization.value
    kb = test_db.query(Kind).filter(Kind.kind == "KnowledgeBase").one()
    assert kb.user_id == admin.id
    assert kb.namespace == "system"
    assert kb.json["metadata"]["labels"]["seed_id"] == "wegent-help"
    doc = test_db.query(KnowledgeDocument).one()
    assert doc.kind_id == kb.id
    assert doc.name == "Quick Start"
    assert doc.source_config["source_path"] == "docs/en/quick-start.md"
    schedule.assert_called_once()


def test_system_knowledge_init_is_idempotent(test_db, tmp_path: Path, mocker) -> None:
    admin = _admin_user(test_db)
    init_dir = _write_seed(tmp_path)
    mocker.patch(
        "app.core.system_knowledge_init.schedule_document_indexing_if_possible"
    )

    first = run_system_knowledge_initialization(test_db, admin.id, init_dir)
    second = run_system_knowledge_initialization(test_db, admin.id, init_dir)

    assert first["documents_created"] == 1
    assert second["documents_skipped"] == 1
    assert test_db.query(Kind).filter(Kind.kind == "KnowledgeBase").count() == 1
    assert test_db.query(KnowledgeDocument).count() == 1


def test_system_knowledge_init_updates_changed_document(
    test_db, tmp_path: Path, mocker
) -> None:
    admin = _admin_user(test_db)
    init_dir = _write_seed(tmp_path)
    mocker.patch(
        "app.core.system_knowledge_init.schedule_document_indexing_if_possible"
    )
    run_system_knowledge_initialization(test_db, admin.id, init_dir)
    manifest_path = init_dir / "system_knowledge" / "wegent-help" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["documents"][0]["content_sha256"] = "hash-2"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    doc_file = (
        init_dir / "system_knowledge" / "wegent-help" / "docs" / "en" / "quick-start.md"
    )
    doc_file.write_text("# Quick Start\n\nUpdated.", encoding="utf-8")

    result = run_system_knowledge_initialization(test_db, admin.id, init_dir)

    doc = test_db.query(KnowledgeDocument).one()
    assert result["documents_updated"] == 1
    assert doc.source_config["content_sha256"] == "hash-2"


def test_yaml_initialization_calls_system_knowledge_init(test_db, mocker) -> None:
    mocker.patch("app.core.yaml_init.settings.INIT_DATA_ENABLED", True)
    mocker.patch("app.core.yaml_init.settings.ENVIRONMENT", "development")
    mocker.patch("app.core.yaml_init.ensure_default_user", return_value=(123, False))
    mocker.patch(
        "app.core.yaml_init.scan_and_apply_yaml_directory",
        return_value={"status": "completed", "resources_total": 0},
    )
    system_init = mocker.patch(
        "app.core.yaml_init.run_system_knowledge_initialization",
        return_value={"status": "completed"},
    )

    from app.core.yaml_init import run_yaml_initialization

    result = run_yaml_initialization(test_db)

    assert result["status"] == "completed"
    assert result["system_knowledge"] == {"status": "completed"}
    system_init.assert_called_once()
