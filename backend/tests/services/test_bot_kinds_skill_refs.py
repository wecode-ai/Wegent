# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.kind import Kind
from app.schemas.bot import BotCreate
from app.schemas.kind import SkillRefMeta
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


def test_resolve_skill_refs_accepts_user_default_binding(mocker):
    service = BotKindsService(Kind)
    skill = SimpleNamespace(
        name="h52wbox-cloud",
        id=92,
        namespace="default",
        user_id=2,
        json={},
    )

    query = mocker.Mock()
    query.filter.return_value = query
    query.first.return_value = skill
    db = mocker.Mock()
    db.query.return_value = query
    mocker.patch(
        "app.services.adapters.bot_kinds.skill_binding_service.list_user_default_skill_ids",
        return_value={92},
    )
    fallback = mocker.patch.object(service, "_get_skill_refs")

    refs = service._resolve_skill_refs(
        db=db,
        skill_names=["h52wbox-cloud"],
        user_id=1,
        namespace="default",
        provided_refs={
            "h52wbox-cloud": SkillRefMeta(
                skill_id=92,
                namespace="default",
                is_public=False,
            )
        },
    )

    assert refs["h52wbox-cloud"].skill_id == 92
    fallback.assert_not_called()


def test_resolve_skill_refs_rejects_group_only_skill_for_personal_bot(mocker):
    service = BotKindsService(Kind)
    skill = SimpleNamespace(
        name="h52wbox-cloud",
        id=92,
        namespace="default",
        user_id=2,
        json={},
    )

    query = mocker.Mock()
    query.filter.return_value = query
    query.first.return_value = skill
    db = mocker.Mock()
    db.query.return_value = query
    mocker.patch(
        "app.services.adapters.bot_kinds.skill_binding_service.list_user_default_skill_ids",
        return_value=set(),
    )

    with pytest.raises(HTTPException) as exc_info:
        service._resolve_skill_refs(
            db=db,
            skill_names=["h52wbox-cloud"],
            user_id=1,
            namespace="default",
            provided_refs={
                "h52wbox-cloud": SkillRefMeta(
                    skill_id=92,
                    namespace="default",
                    is_public=False,
                )
            },
        )

    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "Permission denied for skill 'h52wbox-cloud'"


def test_resolve_skill_refs_accepts_skill_available_to_all_target_groups(mocker):
    service = BotKindsService(Kind)
    skill = SimpleNamespace(
        name="h52wbox-cloud",
        id=92,
        namespace="default",
        user_id=2,
        json={},
    )

    query = mocker.Mock()
    query.filter.return_value = query
    query.first.return_value = skill
    db = mocker.Mock()
    db.query.return_value = query
    mocker.patch(
        "app.services.adapters.bot_kinds.skill_binding_service.list_user_default_skill_ids",
        return_value=set(),
    )
    mocker.patch(
        "app.services.adapters.bot_kinds.check_group_permission",
        return_value=True,
    )
    group_access = mocker.patch(
        "app.services.adapters.bot_kinds.skill_binding_service.is_skill_available_to_group",
        return_value=True,
    )

    refs = service._resolve_skill_refs(
        db=db,
        skill_names=["h52wbox-cloud"],
        user_id=1,
        namespace="default",
        provided_refs={
            "h52wbox-cloud": SkillRefMeta(
                skill_id=92,
                namespace="default",
                is_public=False,
            )
        },
        target_group_names=["engineering", "research"],
    )

    assert refs["h52wbox-cloud"].skill_id == 92
    assert [call.kwargs["group_namespace"] for call in group_access.call_args_list] == [
        "engineering",
        "research",
    ]


def test_resolve_skill_refs_rejects_skill_missing_from_one_target_group(mocker):
    service = BotKindsService(Kind)
    skill = SimpleNamespace(
        name="h52wbox-cloud",
        id=92,
        namespace="default",
        user_id=2,
        json={},
    )

    query = mocker.Mock()
    query.filter.return_value = query
    query.first.return_value = skill
    db = mocker.Mock()
    db.query.return_value = query
    mocker.patch(
        "app.services.adapters.bot_kinds.skill_binding_service.list_user_default_skill_ids",
        return_value=set(),
    )
    mocker.patch(
        "app.services.adapters.bot_kinds.check_group_permission",
        return_value=True,
    )
    mocker.patch(
        "app.services.adapters.bot_kinds.skill_binding_service.is_skill_available_to_group",
        side_effect=lambda _db, *, group_namespace, **_kwargs: (
            group_namespace == "engineering"
        ),
    )

    with pytest.raises(HTTPException) as exc_info:
        service._resolve_skill_refs(
            db=db,
            skill_names=["h52wbox-cloud"],
            user_id=1,
            namespace="default",
            provided_refs={
                "h52wbox-cloud": SkillRefMeta(
                    skill_id=92,
                    namespace="default",
                    is_public=False,
                )
            },
            target_group_names=["engineering", "research"],
        )

    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "Permission denied for skill 'h52wbox-cloud'"


def test_resolve_skill_refs_rejects_unreadable_target_group(mocker):
    service = BotKindsService(Kind)
    group_permission = mocker.patch(
        "app.services.adapters.bot_kinds.check_group_permission",
        side_effect=lambda _db, _user_id, group_name, _role: (
            group_name == "engineering"
        ),
    )

    with pytest.raises(HTTPException) as exc_info:
        service._resolve_skill_refs(
            db=mocker.Mock(),
            skill_names=["system-skill"],
            user_id=1,
            namespace="default",
            provided_refs={
                "system-skill": SkillRefMeta(
                    skill_id=92,
                    namespace="default",
                    is_public=True,
                )
            },
            target_group_names=["engineering", "private-team"],
        )

    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "Group access denied: private-team"
    assert group_permission.call_count == 2


def test_resolve_skill_refs_rejects_unresolved_legacy_skill_names(mocker):
    service = BotKindsService(Kind)
    db = mocker.Mock()
    mocker.patch.object(service, "_get_skill_refs", return_value={})

    with pytest.raises(HTTPException) as exc_info:
        service._resolve_skill_refs(
            db=db,
            skill_names=["missing-skill"],
            user_id=1,
            namespace="default",
            provided_refs=None,
        )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == ("The following Skills do not exist: missing-skill")


def test_create_with_user_resolves_explicit_skill_refs_before_persisting(mocker):
    service = BotKindsService(Kind)
    db = mocker.Mock()
    added_objects = []
    db.add.side_effect = added_objects.append
    query = mocker.Mock()
    query.filter.return_value = query
    query.first.return_value = None
    db.query.return_value = query
    skill_ref = SkillRefMeta(
        skill_id=92,
        namespace="default",
        is_public=False,
    )
    resolve_refs = mocker.patch.object(
        service,
        "_resolve_skill_refs",
        return_value={"h52wbox-cloud": skill_ref},
    )
    legacy_validation = mocker.patch.object(service, "_validate_skills")
    mocker.patch.object(service, "_encrypt_agent_config", return_value={})
    mocker.patch.object(service, "_get_model_by_name", return_value=None)
    mocker.patch.object(service, "_convert_to_bot_dict", return_value={"id": 1})
    mocker.patch(
        "app.services.adapters.bot_kinds.get_shell_info_by_name",
        return_value={
            "shell_type": "Chat",
            "execution_type": "local_engine",
            "base_image": "python:3.11",
            "is_custom": False,
            "namespace": "default",
        },
    )
    mocker.patch(
        "app.services.adapters.bot_kinds.get_shell_by_name",
        return_value=None,
    )

    service.create_with_user(
        db,
        obj_in=BotCreate(
            name="personal-skill-bot",
            shell_name="Chat",
            agent_config={},
            skills=["h52wbox-cloud"],
            skill_refs={"h52wbox-cloud": skill_ref},
        ),
        user_id=1,
    )

    ghost = next(
        obj for obj in added_objects if isinstance(obj, Kind) and obj.kind == "Ghost"
    )
    assert ghost.json["spec"]["skill_refs"]["h52wbox-cloud"]["skill_id"] == 92
    resolve_refs.assert_called_once()
    legacy_validation.assert_not_called()
