# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy.orm import Session

from app.models.im_session import IMSessionMode, IMSessionState
from app.models.user import User
from app.services.im.command_router import IMCommandAction, im_command_router
from app.services.im.session_service import im_session_service


def _create_session(
    db: Session,
    user: User,
    *,
    conversation_id: str = "conv-router",
):
    return im_session_service.get_or_create_private_session(
        db=db,
        user_id=user.id,
        channel_type="dingtalk",
        channel_id=12,
        conversation_id=conversation_id,
        sender_id="staff-a",
        display_name="Alice",
    )


def _recent_tasks() -> list[dict[str, object]]:
    return [
        {"id": 101, "title": "修复登录问题"},
        {"id": 102, "title": "整理任务文档"},
    ]


def _projects() -> list[dict[str, object]]:
    return [
        {"id": 201, "name": "Wegent Backend"},
        {"id": 202, "name": "Wegent Docs"},
    ]


def test_bind_command_is_handled_with_bound_reply(
    test_db: Session,
    test_user: User,
) -> None:
    session = _create_session(test_db, test_user)

    result = im_command_router.route(
        test_db,
        session,
        "/bind",
        recent_tasks=[],
        projects=[],
    )

    assert result.handled is True
    assert result.action == IMCommandAction.NONE
    assert "已绑定" in result.reply


def test_task_without_active_task_enters_pending_switch_and_lists_recent_tasks(
    test_db: Session,
    test_user: User,
) -> None:
    session = _create_session(test_db, test_user)

    result = im_command_router.route(
        test_db,
        session,
        "/task",
        recent_tasks=_recent_tasks(),
        projects=[],
    )

    assert result.handled is True
    assert result.action == IMCommandAction.NONE
    assert session.mode == IMSessionMode.TASK
    assert session.state == IMSessionState.PENDING_TASK_SWITCH
    assert session.pending_payload["task_ids"] == [101, 102]
    assert "最近任务" in result.reply
    assert "修复登录问题" in result.reply


def test_pending_switch_accepts_number_and_returns_bind_task(
    test_db: Session,
    test_user: User,
) -> None:
    session = _create_session(test_db, test_user)
    im_session_service.set_pending_state(
        test_db,
        session=session,
        state=IMSessionState.PENDING_TASK_SWITCH,
        payload={"task_ids": [101, 102]},
    )

    result = im_command_router.route(
        test_db,
        session,
        "2",
        recent_tasks=[],
        projects=[],
    )

    assert result.handled is True
    assert result.action == IMCommandAction.BIND_TASK
    assert result.task_id == 102
    assert session.state == IMSessionState.IDLE
    assert session.pending_payload == {}


def test_task_mode_without_active_task_stores_first_message_and_lists_projects(
    test_db: Session,
    test_user: User,
) -> None:
    session = _create_session(test_db, test_user)
    im_session_service.set_mode(test_db, session=session, mode=IMSessionMode.TASK)

    result = im_command_router.route(
        test_db,
        session,
        "修复 IM 私聊任务创建",
        recent_tasks=[],
        projects=_projects(),
    )

    assert result.handled is True
    assert result.action == IMCommandAction.NONE
    assert session.state == IMSessionState.PENDING_TASK_CREATION
    assert session.pending_payload["first_message"] == "修复 IM 私聊任务创建"
    assert session.pending_payload["project_ids"] == [201, 202]
    assert "选择项目" in result.reply
    assert "Wegent Backend" in result.reply


def test_pending_creation_standalone_choice_returns_create_task(
    test_db: Session,
    test_user: User,
) -> None:
    session = _create_session(test_db, test_user)
    im_session_service.set_pending_state(
        test_db,
        session=session,
        state=IMSessionState.PENDING_TASK_CREATION,
        payload={"first_message": "创建独立任务", "project_ids": [201, 202]},
    )

    result = im_command_router.route(
        test_db,
        session,
        "0",
        recent_tasks=[],
        projects=_projects(),
    )

    assert result.handled is True
    assert result.action == IMCommandAction.CREATE_TASK
    assert result.project_id is None
    assert result.message == "创建独立任务"
    assert session.state == IMSessionState.IDLE
    assert session.pending_payload == {}


def test_chat_command_clears_active_task_and_switches_to_chat(
    test_db: Session,
    test_user: User,
) -> None:
    session = _create_session(test_db, test_user)
    im_session_service.bind_active_task(test_db, session=session, task_id=7001)

    result = im_command_router.route(
        test_db,
        session,
        "/chat",
        recent_tasks=[],
        projects=[],
    )

    assert result.handled is True
    assert result.action == IMCommandAction.NONE
    assert session.mode == IMSessionMode.CHAT
    assert session.active_task_id is None
    assert "Chat" in result.reply


def test_chat_mode_non_command_returns_unhandled(
    test_db: Session,
    test_user: User,
) -> None:
    session = _create_session(test_db, test_user)

    result = im_command_router.route(
        test_db,
        session,
        "普通聊天消息",
        recent_tasks=[],
        projects=[],
    )

    assert result.handled is False
    assert result.action == IMCommandAction.NONE


def test_invalid_pending_input_keeps_pending_state_and_returns_guidance(
    test_db: Session,
    test_user: User,
) -> None:
    session = _create_session(test_db, test_user)
    im_session_service.set_pending_state(
        test_db,
        session=session,
        state=IMSessionState.PENDING_TASK_SWITCH,
        payload={"task_ids": [101, 102]},
    )

    result = im_command_router.route(
        test_db,
        session,
        "不是序号",
        recent_tasks=[],
        projects=[],
    )

    assert result.handled is True
    assert result.action == IMCommandAction.NONE
    assert session.state == IMSessionState.PENDING_TASK_SWITCH
    assert session.pending_payload == {"task_ids": [101, 102]}
    assert "序号" in result.reply
