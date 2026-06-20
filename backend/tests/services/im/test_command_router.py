# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from sqlalchemy.orm import Session

from app.models.im_session import IMSessionMode, IMSessionState
from app.models.user import User
from app.services.im.command_router import IMCommandAction, im_command_router
from app.services.im.session_service import im_session_service

pytestmark = pytest.mark.asyncio


async def _create_session(
    db: Session,
    user: User,
    *,
    conversation_id: str = "conv-router",
):
    return await im_session_service.get_or_create_private_session(
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


async def test_bind_command_is_handled_with_bound_reply(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)

    result = await im_command_router.route(
        test_db,
        session,
        "/bind",
        recent_tasks=[],
        projects=[],
    )

    assert result.handled is True
    assert result.action == IMCommandAction.NONE
    assert "已绑定" in result.reply


async def test_task_without_active_task_enters_pending_switch_and_lists_recent_tasks(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)

    result = await im_command_router.route(
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


async def test_mode_command_returns_current_task_mode_and_active_task_id(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)
    await im_session_service.bind_active_task(test_db, session=session, task_id=7001)

    result = await im_command_router.route(
        test_db,
        session,
        "/mode",
        recent_tasks=[],
        projects=[],
    )

    assert result.handled is True
    assert result.action == IMCommandAction.NONE
    assert result.task_id is None
    assert result.reply == "当前模式：Task，任务 ID：7001。"


async def test_mode_task_argument_enters_pending_switch(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)

    result = await im_command_router.route(
        test_db,
        session,
        "/mode task",
        recent_tasks=_recent_tasks(),
        projects=[],
    )

    assert result.handled is True
    assert result.action == IMCommandAction.NONE
    assert session.mode == IMSessionMode.TASK
    assert session.state == IMSessionState.PENDING_TASK_SWITCH
    assert session.pending_payload == {"task_ids": [101, 102]}
    assert "最近任务" in result.reply


async def test_mode_chat_argument_switches_to_chat(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)
    await im_session_service.bind_active_task(test_db, session=session, task_id=7001)

    result = await im_command_router.route(
        test_db,
        session,
        "/mode chat",
        recent_tasks=[],
        projects=[],
    )

    assert result.handled is True
    assert result.action == IMCommandAction.NONE
    assert session.mode == IMSessionMode.CHAT
    assert session.active_task_id is None
    assert result.reply == "已切换到 Chat 模式。"


async def test_switch_command_enters_pending_switch_and_lists_recent_tasks(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)

    result = await im_command_router.route(
        test_db,
        session,
        "/switch",
        recent_tasks=_recent_tasks(),
        projects=[],
    )

    assert result.handled is True
    assert result.action == IMCommandAction.NONE
    assert session.mode == IMSessionMode.TASK
    assert session.state == IMSessionState.PENDING_TASK_SWITCH
    assert session.pending_payload == {"task_ids": [101, 102]}
    assert "最近任务" in result.reply
    assert "1. 修复登录问题（101）" in result.reply
    assert "2. 整理任务文档（102）" in result.reply


async def test_pending_switch_accepts_number_and_returns_bind_task(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)
    await im_session_service.set_pending_state(
        test_db,
        session=session,
        state=IMSessionState.PENDING_TASK_SWITCH,
        payload={"task_ids": [101, 102]},
    )

    result = await im_command_router.route(
        test_db,
        session,
        "2",
        recent_tasks=[],
        projects=[],
    )

    assert result.handled is True
    assert result.action == IMCommandAction.BIND_TASK
    assert result.task_id == 102
    assert result.reply == "已选择任务 102。"
    assert session.state == IMSessionState.PENDING_TASK_SWITCH
    assert session.pending_payload == {"task_ids": [101, 102]}


async def test_pending_switch_new_begins_task_creation(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)
    await im_session_service.set_pending_state(
        test_db,
        session=session,
        state=IMSessionState.PENDING_TASK_SWITCH,
        payload={"task_ids": [101, 102], "first_message": "从切换流程新建任务"},
    )

    result = await im_command_router.route(
        test_db,
        session,
        "new",
        recent_tasks=[],
        projects=_projects(),
    )

    assert result.handled is True
    assert result.action == IMCommandAction.NONE
    assert session.state == IMSessionState.PENDING_TASK_CREATION
    assert session.pending_payload == {
        "first_message": "从切换流程新建任务",
        "project_ids": [201, 202],
    }
    assert "选择项目" in result.reply
    assert "0. 不关联项目" in result.reply
    assert "1. Wegent Backend（201）" in result.reply


async def test_task_mode_without_active_task_stores_first_message_and_lists_projects(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)
    await im_session_service.set_mode(test_db, session=session, mode=IMSessionMode.TASK)

    result = await im_command_router.route(
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


async def test_new_command_in_task_mode_enters_new_flow(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)
    await im_session_service.set_mode(test_db, session=session, mode=IMSessionMode.TASK)

    result = await im_command_router.route(
        test_db,
        session,
        "/new",
        recent_tasks=[],
        projects=_projects(),
    )

    assert result.handled is True
    assert result.action == IMCommandAction.NONE
    assert session.mode == IMSessionMode.TASK
    assert session.state == IMSessionState.PENDING_NEW_FLOW
    assert session.pending_payload == {}
    assert "请选择新建类型" in result.reply
    assert "1. 新建 Chat" in result.reply
    assert "2. 新建 Task" in result.reply
    assert "3. 继续最近 Task" in result.reply


async def test_new_command_in_chat_mode_enters_new_flow(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)

    result = await im_command_router.route(
        test_db,
        session,
        "/new",
        recent_tasks=_recent_tasks(),
        projects=_projects(),
    )

    assert result.handled is True
    assert result.action == IMCommandAction.NONE
    assert session.mode == IMSessionMode.CHAT
    assert session.state == IMSessionState.PENDING_NEW_FLOW
    assert "请选择新建类型" in result.reply
    assert "1. 新建 Chat" in result.reply
    assert "2. 新建 Task" in result.reply
    assert "3. 继续最近 Task" in result.reply


async def test_new_command_then_cancel_from_chat_mode_keeps_chat_mode(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)

    start_result = await im_command_router.route(
        test_db,
        session,
        "/new",
        recent_tasks=_recent_tasks(),
        projects=_projects(),
    )
    cancel_result = await im_command_router.route(
        test_db,
        session,
        "/cancel",
        recent_tasks=[],
        projects=[],
    )

    assert start_result.handled is True
    assert cancel_result.handled is True
    assert cancel_result.reply == "已取消。"
    assert session.mode == IMSessionMode.CHAT
    assert session.state == IMSessionState.IDLE
    assert session.pending_payload == {}


async def test_new_flow_choice_chat_returns_start_chat_action(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)
    await im_session_service.set_pending_state(
        test_db,
        session=session,
        state=IMSessionState.PENDING_NEW_FLOW,
        payload={},
    )

    result = await im_command_router.route(
        test_db,
        session,
        "1",
        recent_tasks=[],
        projects=[],
    )

    assert result.handled is True
    assert result.action == IMCommandAction.START_CHAT
    assert session.mode == IMSessionMode.CHAT
    assert result.reply == "已开始新 Chat，请发送消息。"


async def test_new_flow_choice_task_enters_project_selection(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)
    await im_session_service.set_pending_state(
        test_db,
        session=session,
        state=IMSessionState.PENDING_NEW_FLOW,
        payload={},
    )

    result = await im_command_router.route(
        test_db,
        session,
        "2",
        recent_tasks=[],
        projects=_projects(),
    )

    assert result.handled is True
    assert result.action == IMCommandAction.NONE
    assert session.mode == IMSessionMode.TASK
    assert session.state == IMSessionState.PENDING_TASK_CREATION
    assert session.pending_payload == {"first_message": "", "project_ids": [201, 202]}
    assert "选择项目" in result.reply


async def test_new_flow_choice_recent_tasks_enters_task_switch(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)
    await im_session_service.set_pending_state(
        test_db,
        session=session,
        state=IMSessionState.PENDING_NEW_FLOW,
        payload={},
    )

    result = await im_command_router.route(
        test_db,
        session,
        "3",
        recent_tasks=_recent_tasks(),
        projects=[],
    )

    assert result.handled is True
    assert result.action == IMCommandAction.NONE
    assert session.mode == IMSessionMode.TASK
    assert session.state == IMSessionState.PENDING_TASK_SWITCH
    assert session.pending_payload == {"task_ids": [101, 102]}
    assert "最近任务" in result.reply


async def test_new_flow_invalid_choice_keeps_pending_state_and_returns_guidance(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)

    start_result = await im_command_router.route(
        test_db,
        session,
        "/new",
        recent_tasks=[],
        projects=[],
    )
    result = await im_command_router.route(
        test_db,
        session,
        "bad choice",
        recent_tasks=[],
        projects=[],
    )

    assert start_result.handled is True
    assert result.handled is True
    assert result.action == IMCommandAction.NONE
    assert result.reply == "请输入 1、2 或 3，或发送 /cancel 取消。"
    assert session.mode == IMSessionMode.CHAT
    assert session.state == IMSessionState.PENDING_NEW_FLOW
    assert session.pending_payload == {}


@pytest.mark.parametrize(
    ("choice", "expected_project_id"),
    [
        ("0", None),
        ("2", 202),
    ],
)
async def test_new_task_empty_prompt_waits_for_content_before_create_task(
    test_db: Session,
    test_user: User,
    choice: str,
    expected_project_id: int | None,
) -> None:
    session = await _create_session(test_db, test_user)
    await im_session_service.set_mode(test_db, session=session, mode=IMSessionMode.TASK)

    start_result = await im_command_router.route(
        test_db,
        session,
        "/new",
        recent_tasks=[],
        projects=_projects(),
    )

    assert start_result.handled is True
    assert start_result.action == IMCommandAction.NONE
    assert session.state == IMSessionState.PENDING_NEW_FLOW
    assert session.pending_payload == {}

    task_result = await im_command_router.route(
        test_db,
        session,
        "2",
        recent_tasks=[],
        projects=_projects(),
    )

    assert task_result.handled is True
    assert task_result.action == IMCommandAction.NONE
    assert session.state == IMSessionState.PENDING_TASK_CREATION
    assert session.pending_payload == {"first_message": "", "project_ids": [201, 202]}

    choice_result = await im_command_router.route(
        test_db,
        session,
        choice,
        recent_tasks=[],
        projects=_projects(),
    )

    assert choice_result.handled is True
    assert choice_result.action == IMCommandAction.NONE
    assert choice_result.project_id is None
    assert choice_result.message is None
    assert "任务内容" in choice_result.reply
    assert session.state == IMSessionState.PENDING_TASK_CREATION
    assert session.pending_payload == {
        "first_message": "",
        "project_ids": [201, 202],
        "selected_project_id": expected_project_id,
    }

    content_result = await im_command_router.route(
        test_db,
        session,
        "实现私聊任务创建",
        recent_tasks=[],
        projects=_projects(),
    )

    assert content_result.handled is True
    assert content_result.action == IMCommandAction.CREATE_TASK
    assert content_result.project_id == expected_project_id
    assert content_result.message == "实现私聊任务创建"
    assert session.state == IMSessionState.PENDING_TASK_CREATION
    assert session.pending_payload == {
        "first_message": "",
        "project_ids": [201, 202],
        "selected_project_id": expected_project_id,
    }


async def test_pending_creation_standalone_choice_returns_create_task(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)
    await im_session_service.set_pending_state(
        test_db,
        session=session,
        state=IMSessionState.PENDING_TASK_CREATION,
        payload={"first_message": "创建独立任务", "project_ids": [201, 202]},
    )

    result = await im_command_router.route(
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
    assert result.reply == "已开始创建任务。"
    assert session.state == IMSessionState.PENDING_TASK_CREATION
    assert session.pending_payload == {
        "first_message": "创建独立任务",
        "project_ids": [201, 202],
    }


async def test_pending_creation_project_choice_returns_create_task_with_project(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)
    await im_session_service.set_pending_state(
        test_db,
        session=session,
        state=IMSessionState.PENDING_TASK_CREATION,
        payload={"first_message": "创建项目任务", "project_ids": [201, 202]},
    )

    result = await im_command_router.route(
        test_db,
        session,
        "2",
        recent_tasks=[],
        projects=_projects(),
    )

    assert result.handled is True
    assert result.action == IMCommandAction.CREATE_TASK
    assert result.project_id == 202
    assert result.message == "创建项目任务"
    assert result.reply == "已开始创建任务。"
    assert session.state == IMSessionState.PENDING_TASK_CREATION
    assert session.pending_payload == {
        "first_message": "创建项目任务",
        "project_ids": [201, 202],
    }


async def test_chat_command_clears_active_task_and_switches_to_chat(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)
    await im_session_service.bind_active_task(test_db, session=session, task_id=7001)

    result = await im_command_router.route(
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


async def test_cancel_command_clears_pending_state_and_payload(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)
    await im_session_service.set_pending_state(
        test_db,
        session=session,
        state=IMSessionState.PENDING_TASK_CREATION,
        payload={"first_message": "待取消任务", "project_ids": [201]},
    )

    result = await im_command_router.route(
        test_db,
        session,
        "/cancel",
        recent_tasks=[],
        projects=[],
    )

    assert result.handled is True
    assert result.action == IMCommandAction.NONE
    assert result.reply == "已取消。"
    assert session.state == IMSessionState.IDLE
    assert session.pending_payload == {}
    assert session.state_expires_at is None


async def test_task_mode_normal_message_with_active_task_returns_continue_task(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)
    await im_session_service.bind_active_task(test_db, session=session, task_id=7001)

    result = await im_command_router.route(
        test_db,
        session,
        "继续修复登录问题",
        recent_tasks=[],
        projects=[],
    )

    assert result.handled is True
    assert result.action == IMCommandAction.CONTINUE_TASK
    assert result.task_id == 7001
    assert result.message == "继续修复登录问题"
    assert result.reply is None
    assert session.active_task_id == 7001
    assert session.state == IMSessionState.IDLE


async def test_chat_mode_non_command_returns_unhandled(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)

    result = await im_command_router.route(
        test_db,
        session,
        "普通聊天消息",
        recent_tasks=[],
        projects=[],
    )

    assert result.handled is False
    assert result.action == IMCommandAction.NONE


async def test_invalid_pending_input_keeps_pending_state_and_returns_guidance(
    test_db: Session,
    test_user: User,
) -> None:
    session = await _create_session(test_db, test_user)
    await im_session_service.set_pending_state(
        test_db,
        session=session,
        state=IMSessionState.PENDING_TASK_SWITCH,
        payload={"task_ids": [101, 102]},
    )

    result = await im_command_router.route(
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
