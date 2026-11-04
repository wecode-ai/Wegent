# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

import io
import json
import os
import zipfile
from copy import deepcopy
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.models.kind import Kind
from app.models.skill_binary import SkillBinary
from app.services.skill_binding_service import skill_binding_service
from app.services.skill_catalog import (
    CatalogAsset,
    SkillCatalog,
    package_asset,
    publish_catalog,
)
from app.services.skill_runtime import select_runtime_skill_names

pytestmark = pytest.mark.unit
CATALOG = Path(__file__).resolve().parents[2] / "skill_catalogs/document.json"
FORMATS = ["docx", "xlsx", "pptx", "pdf"]


@pytest.fixture
def sources(tmp_path):
    for name in ["document", *FORMATS]:
        directory = tmp_path / name
        (directory / "scripts").mkdir(parents=True)
        metadata = ""
        if name == "document":
            metadata = (
                "provider: {module: provider, class: DocumentToolProvider}\n"
                "tools: [{name: load_document_skill, provider: document}]\n"
                "dependencies: [sandbox]\n"
            )
        (directory / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: Test {name}\n{metadata}---\n"
            f"Read scripts/render.py relative to this Skill. {name}\n"
        )
        (directory / "scripts/render.py").write_text("print('v1')\n")
        (directory / "scripts/render.py").chmod(0o755)
        (directory / "provider.py").write_text("# Original Chat provider\n")
    return {"chat": tmp_path, "native": tmp_path}


def add_kind(db, kind, name, spec, owner=0, active=True):
    row = Kind(
        kind=kind,
        name=name,
        user_id=owner,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": kind,
            "metadata": {"name": name, "namespace": "default"},
            "spec": spec,
        },
        is_active=active,
    )
    db.add(row)
    db.flush()
    return row


def catalog():
    return SkillCatalog.model_validate_json(CATALOG.read_text())


def test_fresh_publish_uses_normal_assets_and_shells(test_db, sources):
    ghost = add_kind(test_db, "Ghost", "wegent-wework", {"skills": []})
    report = publish_catalog(test_db, catalog(), sources)
    test_db.commit()
    assert list(report["assets"]) == ["document", *FORMATS]
    assert ghost.json["spec"]["skills"] == ["document", *FORMATS]
    refs = ghost.json["spec"]["skill_refs"]
    for shell, expected in [
        ("Chat", ["document"]),
        ("ClaudeCode", FORMATS),
        ("Codex", FORMATS),
    ]:
        assert (
            select_runtime_skill_names(
                {"skills": list(refs), "skill_refs": refs, "shell_type": shell}
            )
            == expected
        )
    for name, skill_id in report["assets"].items():
        binary = test_db.query(SkillBinary).filter_by(kind_id=skill_id).one()
        with zipfile.ZipFile(io.BytesIO(binary.binary_data)) as archive:
            assert archive.read(f"{name}/scripts/render.py") == b"print('v1')\n"
            assert (
                archive.getinfo(f"{name}/scripts/render.py").external_attr >> 16 & 0o111
            )
            if name == "document":
                assert (
                    archive.read("document/provider.py")
                    == b"# Original Chat provider\n"
                )
                asset = test_db.get(Kind, skill_id)
                assert asset.json["spec"]["provider"]["class"] == "DocumentToolProvider"
                assert asset.json["spec"]["tools"][0]["name"] == "load_document_skill"


def test_upgrade_preserves_ids_private_assets_and_exact_bindings(
    test_db, test_user, sources
):
    first = publish_catalog(test_db, catalog(), sources)
    document_id = first["assets"]["document"]
    private = add_kind(
        test_db, "Skill", "document", {"description": "Private"}, test_user.id
    )
    custom_docx = add_kind(
        test_db, "Skill", "docx", {"description": "Custom"}, test_user.id
    )
    public_ref = {"skill_id": document_id, "namespace": "default", "is_public": True}
    public = add_kind(
        test_db,
        "Ghost",
        "public-reference",
        {
            "skills": ["document", "docx"],
            "skill_refs": {
                "document": public_ref,
                "docx": {"skill_id": custom_docx.id, "is_public": False},
            },
        },
        test_user.id,
    )
    private_ghost = add_kind(
        test_db,
        "Ghost",
        "private-reference",
        {
            "skills": ["document"],
            "skill_refs": {
                "document": {"skill_id": private.id, "is_public": False},
            },
        },
        test_user.id,
    )
    legacy_private = add_kind(
        test_db, "Ghost", "legacy-private", {"skills": ["document"]}, test_user.id
    )
    legacy_public = add_kind(
        test_db, "Ghost", "legacy-public", {"skills": ["document"]}
    )
    before_private = deepcopy(private_ghost.json)
    (sources["native"] / "docx/scripts/render.py").write_text("print('v2')\n")
    second = publish_catalog(test_db, catalog(), sources)
    test_db.commit()
    assert second["assets"] == first["assets"]
    assert public.json["spec"]["skill_refs"]["docx"]["skill_id"] == custom_docx.id
    assert public.json["spec"]["skills"] == ["document", *FORMATS]
    assert private_ghost.json == before_private
    assert legacy_private.json["spec"]["skills"] == ["document"]
    assert (
        legacy_public.json["spec"]["skill_refs"]["document"]["skill_id"] == document_id
    )
    assert private.json["spec"]["description"] == "Private"
    assert publish_catalog(test_db, catalog(), sources)["bindings"] == []


@pytest.mark.parametrize("active", [True, False])
def test_binding_migration_retains_settings_and_disabled_state(
    test_db, test_user, sources, active
):
    initial = publish_catalog(test_db, catalog(), sources)
    source_id = initial["assets"]["document"]
    binding = skill_binding_service.add_user_default_skill(
        test_db,
        user_id=test_user.id,
        skill_id=source_id,
        created_by=test_user.id,
        commit=False,
    )
    binding.json["spec"].update(
        forcePreload=True, exceptions=[{"type": "project", "value": "42"}]
    )
    binding.is_active = active
    installed = add_kind(
        test_db,
        "InstalledSkill",
        "original-document",
        {
            "skillRef": {
                "kind": "Skill",
                "name": "document",
                "namespace": "default",
                "user_id": 0,
            },
            "source": {"type": "personal", "skillKey": "document"},
            "enabled": False,
            "installState": "installed",
            "displayName": "Document",
            "description": "Chat",
        },
        test_user.id,
        active,
    )
    report = publish_catalog(test_db, catalog(), sources)
    test_db.commit()
    format_ids = {initial["assets"][name] for name in FORMATS}
    clones = [
        row
        for row in test_db.query(Kind)
        .filter_by(kind="SkillBinding", user_id=test_user.id)
        .all()
        if row.json["spec"]["skillRef"]["skillId"] in format_ids
    ]
    assert len(clones) == 4
    assert all(row.is_active == active for row in clones)
    assert all(row.json["spec"]["forcePreload"] is True for row in clones)
    assert all(
        row.json["spec"]["exceptions"] == [{"type": "project", "value": "42"}]
        for row in clones
    )
    installs = (
        test_db.query(Kind)
        .filter(Kind.name.like(f"catalog-{installed.id}-skill-%"))
        .all()
    )
    assert len(installs) == 4
    assert all(
        row.is_active == active and row.json["spec"]["enabled"] is False
        for row in installs
    )
    assert report["assets"]["document"] == source_id
    assert publish_catalog(test_db, catalog(), sources)["bindings"] == []
    if active:
        for shell, expected in [
            ("Chat", ["document"]),
            ("ClaudeCode", FORMATS),
            ("Codex", FORMATS),
        ]:
            refs = skill_binding_service.list_user_default_skill_refs(
                test_db, test_user.id, shell_type=shell
            )
            assert [ref["name"] for ref in refs] == expected
            assert all(ref["force_preload"] for ref in refs)


def test_invalid_source_and_ambiguous_preload_roll_back_entire_catalog(
    test_db, sources
):
    initial = publish_catalog(test_db, catalog(), sources)
    test_db.commit()
    document_id = initial["assets"]["document"]
    row = add_kind(
        test_db,
        "Ghost",
        "forced-preload",
        {
            "skills": ["document"],
            "preload_skills": ["document"],
            "skill_refs": {"document": {"skill_id": document_id}},
        },
    )
    for shell in ["Chat", "ClaudeCode"]:
        add_kind(test_db, "Shell", shell, {"shellType": shell})
        add_kind(
            test_db,
            "Bot",
            f"preload-{shell}",
            {
                "ghostRef": {"name": row.name, "namespace": "default"},
                "shellRef": {"name": shell, "namespace": "default"},
            },
        )
    test_db.commit()
    old_hash = test_db.get(Kind, initial["assets"]["docx"]).json["status"]["fileHash"]
    (sources["native"] / "docx/scripts/render.py").write_text("v2")
    with pytest.raises(ValueError, match="preloads document"):
        publish_catalog(test_db, catalog(), sources)
    test_db.rollback()
    assert (
        test_db.get(Kind, initial["assets"]["docx"]).json["status"]["fileHash"]
        == old_hash
    )
    assert test_db.get(Kind, row.id).json["spec"]["skills"] == ["document"]
    (sources["native"] / "pdf/SKILL.md").unlink()
    with pytest.raises(HTTPException, match="SKILL.md"):
        publish_catalog(test_db, catalog(), sources)
    assert (
        test_db.get(Kind, initial["assets"]["docx"]).json["status"]["fileHash"]
        == old_hash
    )


def test_packaging_is_complete_deterministic_and_does_not_follow_symlinks(
    sources, tmp_path
):
    asset = catalog().assets[1]
    first = package_asset(asset, sources)
    os.utime(sources["native"] / "docx/SKILL.md", (1, 1))
    assert package_asset(asset, sources) == first
    (sources["native"] / "docx/private").symlink_to(tmp_path / "outside")
    with pytest.raises(ValueError, match="symlink"):
        package_asset(asset, sources)
    with pytest.raises(ValueError, match="escapes"):
        package_asset(
            CatalogAsset(
                name="escape", source="native", path="..", bind_shells=["Codex"]
            ),
            sources,
        )


def test_dry_run_rolls_back_new_assets_and_bindings(test_db, sources):
    report = publish_catalog(test_db, catalog(), sources)
    ids = list(report["assets"].values())
    test_db.rollback()
    assert test_db.query(Kind).filter(Kind.id.in_(ids)).count() == 0


def test_catalog_rejects_unknown_or_duplicate_targets():
    data = json.loads(CATALOG.read_text())
    data["expansions"]["document"] = ["missing"]
    with pytest.raises(ValueError, match="targets"):
        SkillCatalog.model_validate(data)


@pytest.mark.parametrize("shell", ["Chat", "ClaudeCode", "Codex"])
def test_explicit_ghost_and_template_preloads_follow_the_existing_shell(
    test_db, sources, shell
):
    initial = publish_catalog(test_db, catalog(), sources)
    source_ref = {
        "skill_id": initial["assets"]["document"],
        "namespace": "default",
        "is_public": True,
    }
    ghost = add_kind(
        test_db,
        "Ghost",
        "preloaded",
        {
            "skills": ["document"],
            "skill_refs": {"document": source_ref},
            "preload_skills": ["document"],
            "preload_skill_refs": {"document": source_ref},
        },
    )
    add_kind(test_db, "Shell", shell, {"shellType": shell})
    add_kind(
        test_db,
        "Bot",
        "consumer",
        {
            "ghostRef": {"name": ghost.name, "namespace": "default"},
            "shellRef": {"name": shell, "namespace": "default"},
        },
    )
    template = add_kind(
        test_db,
        "Template",
        "translation",
        {
            "resources": {
                "bot": {"shellName": shell},
                "ghost": {
                    "preloadSkillRefs": [
                        {"name": "document", "namespace": "default", "user_id": 0},
                    ]
                },
            }
        },
    )
    publish_catalog(test_db, catalog(), sources)
    expected = ["document"] if shell == "Chat" else FORMATS
    assert ghost.json["spec"]["preload_skills"] == expected
    assert [
        ref["name"]
        for ref in template.json["spec"]["resources"]["ghost"]["preloadSkillRefs"]
    ] == expected


def test_nullable_legacy_lists_and_existing_disabled_destination(
    test_db, test_user, sources
):
    initial = publish_catalog(test_db, catalog(), sources)
    add_kind(test_db, "Ghost", "empty-legacy", {"skills": None, "preload_skills": None})
    document_id = initial["assets"]["document"]
    skill_binding_service.add_user_default_skill(
        test_db,
        user_id=test_user.id,
        skill_id=document_id,
        created_by=test_user.id,
        commit=False,
    )
    existing = skill_binding_service.add_user_default_skill(
        test_db,
        user_id=test_user.id,
        skill_id=initial["assets"]["docx"],
        created_by=test_user.id,
        commit=False,
    )
    existing.is_active = False
    publish_catalog(test_db, catalog(), sources)
    test_db.flush()
    rows = (
        test_db.query(Kind).filter_by(kind="SkillBinding", user_id=test_user.id).all()
    )
    docx_bindings = [
        row
        for row in rows
        if row.json["spec"]["skillRef"]["skillId"] == initial["assets"]["docx"]
    ]
    assert len(docx_bindings) == 1
    assert docx_bindings[0].is_active is False


def test_inherited_forced_preload_fails_without_mutation(test_db, sources):
    initial = publish_catalog(test_db, catalog(), sources)
    ghost = add_kind(
        test_db,
        "Ghost",
        "base-preloaded",
        {
            "skills": ["document"],
            "preload_skills": ["document"],
            "skill_refs": {"document": {"skill_id": initial["assets"]["document"]}},
        },
    )
    add_kind(
        test_db,
        "Ghost",
        "inheriting",
        {
            "baseGhostRef": {
                "name": ghost.name,
                "namespace": ghost.namespace,
                "user_id": ghost.user_id,
            }
        },
    )
    before = deepcopy(ghost.json)
    with pytest.raises(ValueError, match="through inheritance"):
        publish_catalog(test_db, catalog(), sources)
    assert ghost.json == before


def test_private_preload_identity_survives_public_optional_expansion(
    test_db, test_user, sources
):
    initial = publish_catalog(test_db, catalog(), sources)
    private = add_kind(
        test_db, "Skill", "document", {"description": "Private native"}, test_user.id
    )
    private_ref = {"skill_id": private.id, "is_public": False, "namespace": "default"}
    ghost = add_kind(
        test_db,
        "Ghost",
        "mixed-identities",
        {
            "skills": ["document"],
            "preload_skills": ["document"],
            "skill_refs": {"document": {"skill_id": initial["assets"]["document"]}},
            "preload_skill_refs": {"document": private_ref},
        },
        test_user.id,
    )
    publish_catalog(test_db, catalog(), sources)
    assert ghost.json["spec"]["preload_skill_refs"]["document"] == private_ref
    assert ghost.json["spec"]["preload_skills"] == ["document"]


def test_private_template_with_unresolved_shell_is_not_migrated(
    test_db, test_user, sources
):
    template = add_kind(
        test_db,
        "Template",
        "private-template",
        {
            "resources": {
                "bot": {"shellName": "unavailable-custom-shell"},
                "ghost": {
                    "skillRefs": [
                        {
                            "name": "document",
                            "namespace": "default",
                            "user_id": test_user.id,
                        }
                    ]
                },
            }
        },
        test_user.id,
    )
    before = deepcopy(template.json)
    publish_catalog(test_db, catalog(), sources)
    assert template.json == before


def test_migrated_user_binding_supports_settings_remove_and_restore(
    test_db, test_user, sources
):
    initial = publish_catalog(test_db, catalog(), sources)
    skill_binding_service.add_user_default_skill(
        test_db,
        user_id=test_user.id,
        skill_id=initial["assets"]["document"],
        created_by=test_user.id,
        commit=False,
    )
    publish_catalog(test_db, catalog(), sources)
    target_id = initial["assets"]["docx"]
    changed = skill_binding_service.update_user_default_skill_exceptions(
        test_db,
        user_id=test_user.id,
        skill_id=target_id,
        exceptions=[],
        force_preload=True,
        commit=False,
    )
    assert changed.json["spec"]["forcePreload"] is True
    binding_id = changed.id
    skill_binding_service.remove_user_default_skill(
        test_db, user_id=test_user.id, skill_id=target_id, commit=False
    )
    assert target_id not in skill_binding_service.list_user_default_skill_ids(
        test_db, test_user.id
    )
    publish_catalog(test_db, catalog(), sources)
    assert test_db.get(Kind, binding_id).is_active is False
    restored = skill_binding_service.add_user_default_skill(
        test_db,
        user_id=test_user.id,
        skill_id=target_id,
        created_by=test_user.id,
        commit=False,
    )
    assert restored.id == binding_id
    assert target_id in skill_binding_service.list_user_default_skill_ids(
        test_db, test_user.id
    )


def test_migrated_group_binding_supports_remove_and_restore(
    test_db, test_user, sources, mocker
):
    mocker.patch(
        "app.services.group_permission.check_group_permission", return_value=True
    )
    initial = publish_catalog(test_db, catalog(), sources)
    namespace = "catalog-group"
    skill_binding_service.add_group_skill(
        test_db,
        group_namespace=namespace,
        skill_id=initial["assets"]["document"],
        created_by=test_user.id,
        commit=False,
    )
    publish_catalog(test_db, catalog(), sources)
    target_id = initial["assets"]["docx"]
    rows = test_db.query(Kind).filter_by(kind="SkillBinding", namespace=namespace).all()
    migrated = next(
        row for row in rows if row.json["spec"]["skillRef"]["skillId"] == target_id
    )
    skill_binding_service.remove_group_skill(
        test_db,
        group_namespace=namespace,
        skill_id=target_id,
        removed_by=test_user.id,
        commit=False,
    )
    assert migrated.is_active is False
    restored = skill_binding_service.add_group_skill(
        test_db,
        group_namespace=namespace,
        skill_id=target_id,
        created_by=test_user.id,
        commit=False,
    )
    assert restored.id == migrated.id


@pytest.mark.parametrize("active", [True, False])
@pytest.mark.parametrize("canonical_exists", [True, False])
def test_previous_catalog_alias_is_repaired_without_losing_user_settings(
    test_db, test_user, sources, active, canonical_exists
):
    initial = publish_catalog(test_db, catalog(), sources)
    source = skill_binding_service.add_user_default_skill(
        test_db,
        user_id=test_user.id,
        skill_id=initial["assets"]["document"],
        created_by=test_user.id,
        commit=False,
    )
    target_id = initial["assets"]["docx"]
    legacy_spec = deepcopy(source.json["spec"])
    legacy_spec.update(
        skillRef={
            "skillId": target_id,
            "name": "docx",
            "namespace": "default",
            "isPublic": True,
        },
        exceptions=[{"type": "project", "value": "legacy"}],
        forcePreload=True,
    )
    legacy = add_kind(
        test_db,
        "SkillBinding",
        f"catalog-{source.id}-skill-{target_id}",
        legacy_spec,
        test_user.id,
        active,
    )
    canonical = None
    if canonical_exists:
        canonical = skill_binding_service.add_user_default_skill(
            test_db,
            user_id=test_user.id,
            skill_id=target_id,
            created_by=test_user.id,
            commit=False,
        )
        canonical.is_active = False
    publish_catalog(test_db, catalog(), sources)
    if canonical_exists:
        assert canonical.is_active is False
        assert canonical.json["spec"]["exceptions"] == []
        assert legacy.is_active is False
    else:
        assert legacy.name == skill_binding_service.build_user_default_name(
            test_user.id, target_id
        )
        assert legacy.json["metadata"]["name"] == legacy.name
        assert legacy.is_active == active
        assert legacy.json["spec"]["forcePreload"] is True
        assert legacy.json["spec"]["exceptions"] == [
            {"type": "project", "value": "legacy"}
        ]
    assert publish_catalog(test_db, catalog(), sources)["bindings"] == []


def test_existing_group_destination_from_another_member_is_preserved(
    test_db, test_user, test_admin_user, sources, mocker
):
    mocker.patch(
        "app.services.group_permission.check_group_permission", return_value=True
    )
    initial = publish_catalog(test_db, catalog(), sources)
    namespace = "catalog-group"
    skill_binding_service.add_group_skill(
        test_db,
        group_namespace=namespace,
        skill_id=initial["assets"]["document"],
        created_by=test_user.id,
        commit=False,
    )
    target_id = initial["assets"]["docx"]
    original = skill_binding_service.add_group_skill(
        test_db,
        group_namespace=namespace,
        skill_id=target_id,
        created_by=test_admin_user.id,
        commit=False,
    )
    original.is_active = False
    publish_catalog(test_db, catalog(), sources)
    rows = test_db.query(Kind).filter_by(kind="SkillBinding", namespace=namespace).all()
    matches = [
        row for row in rows if row.json["spec"]["skillRef"]["skillId"] == target_id
    ]
    assert [row.id for row in matches] == [original.id]
    assert original.is_active is False


def test_duplicate_source_bindings_share_one_destination_with_autoflush_disabled(
    test_db, test_user, sources, monkeypatch
):
    monkeypatch.setattr(test_db, "autoflush", False)
    initial = publish_catalog(test_db, catalog(), sources)
    source = skill_binding_service.add_user_default_skill(
        test_db,
        user_id=test_user.id,
        skill_id=initial["assets"]["document"],
        created_by=test_user.id,
        commit=False,
    )
    add_kind(
        test_db,
        "SkillBinding",
        "older-document-binding",
        deepcopy(source.json["spec"]),
        test_user.id,
    )
    publish_catalog(test_db, catalog(), sources)
    target_id = initial["assets"]["docx"]
    matches = [
        row
        for row in test_db.query(Kind)
        .filter_by(kind="SkillBinding", user_id=test_user.id)
        .all()
        if row.json["spec"]["skillRef"]["skillId"] == target_id
    ]
    assert len(matches) == 1
    assert matches[0].name == skill_binding_service.build_user_default_name(
        test_user.id, target_id
    )
