# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk interactive cards for model, device, agent, and task selection."""

import logging
import secrets
from dataclasses import asdict, dataclass, field
from typing import Any, Callable

import dingtalk_stream
from dingtalk_stream import AckMessage, CallbackMessage, CardCallbackMessage
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.db.session import SessionLocal
from app.models.im_session import IMPrivateSession, IMSessionMode
from app.models.kind import Kind
from app.models.user import User
from app.services.channels.commands import CommandType, parse_command
from app.services.channels.device_selection import DeviceType, device_selection_manager
from app.services.channels.dingtalk.card_transport import (
    DingTalkCardSpace,
    DingTalkCardTransport,
    stringify_card_data,
)
from app.services.channels.dingtalk.user_resolver import DingTalkUserResolver
from app.services.channels.selection_service import (
    SelectionApplyResult,
    SelectionError,
    SelectionKind,
    SelectionOption,
    channel_selection_service,
)
from app.services.im.session_service import im_session_service
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)

CARD_STATE_PREFIX = "dingtalk:selection_card:"
CARD_ACTION_PREFIX = "dingtalk:selection_action:"
ACTIVE_CARD_PREFIX = "dingtalk:active_selection_card:"
INTERACTION_CARD_TTL_SECONDS = 15 * 60
CONVERSATION_CARD_TTL_SECONDS = 24 * 60 * 60
PAGE_SIZE = 8


@dataclass
class DingTalkSelectionCardState:
    """Server-owned card context; resource IDs never leave this state."""

    card_type: str
    channel_id: int
    interaction_template_id: str
    actor_staff_id: str
    user_id: int
    conversation_id: str
    conversation_type: str
    space_type: str
    space_id: str
    session_key: str = ""
    kind: str = ""
    page: int = 0
    option_values: dict[str, str] = field(default_factory=dict)
    status: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: Any) -> "DingTalkSelectionCardState | None":
        if not isinstance(value, dict):
            return None
        try:
            return cls(
                card_type=str(value["card_type"]),
                channel_id=int(value["channel_id"]),
                interaction_template_id=str(value["interaction_template_id"]),
                actor_staff_id=str(value["actor_staff_id"]),
                user_id=int(value["user_id"]),
                conversation_id=str(value["conversation_id"]),
                conversation_type=str(value["conversation_type"]),
                space_type=str(value["space_type"]),
                space_id=str(value["space_id"]),
                session_key=str(value.get("session_key") or ""),
                kind=str(value.get("kind") or ""),
                page=max(0, int(value.get("page") or 0)),
                option_values=dict(value.get("option_values") or {}),
                status=str(value.get("status") or ""),
            )
        except (KeyError, TypeError, ValueError):
            return None

    @property
    def space(self) -> DingTalkCardSpace:
        return DingTalkCardSpace(self.space_type, self.space_id)


async def save_conversation_card_state(
    *,
    out_track_id: str,
    channel_id: int,
    interaction_template_id: str,
    user_id: int,
    incoming_message: Any,
) -> None:
    """Make a completed answer card's settings action resolvable by any worker."""

    actor_staff_id = str(getattr(incoming_message, "sender_staff_id", "") or "")
    if not out_track_id or not interaction_template_id or not actor_staff_id:
        return
    space = DingTalkCardSpace.from_message(incoming_message)
    conversation_type = "group" if space.space_type == "IM_GROUP" else "private"
    session_key = ""
    if conversation_type == "private":
        session_key = im_session_service.build_session_key(
            user_id=user_id,
            channel_type="dingtalk",
            channel_id=channel_id,
            conversation_id=str(getattr(incoming_message, "conversation_id", "") or ""),
        )
    state = DingTalkSelectionCardState(
        card_type="conversation",
        channel_id=channel_id,
        interaction_template_id=interaction_template_id,
        actor_staff_id=actor_staff_id,
        user_id=user_id,
        conversation_id=str(getattr(incoming_message, "conversation_id", "") or ""),
        conversation_type=conversation_type,
        space_type=space.space_type,
        space_id=space.space_id,
        session_key=session_key,
    )
    await _save_state(out_track_id, state, CONVERSATION_CARD_TTL_SECONDS)


class DingTalkSelectionCardService:
    """Create, render, and apply all selection-card actions."""

    def __init__(
        self,
        *,
        client: Any,
        channel_id: int,
        interaction_template_id: str,
        get_default_team_id: Callable[[], int | None],
        get_default_model_name: Callable[[], str | None],
        get_user_mapping_config: Callable[[], Any],
    ) -> None:
        self._transport = DingTalkCardTransport(client)
        self._channel_id = channel_id
        self._interaction_template_id = interaction_template_id
        self._get_default_team_id = get_default_team_id
        self._get_default_model_name = get_default_model_name
        self._get_user_mapping_config = get_user_mapping_config

    async def open_from_message(
        self,
        *,
        db: Session,
        user: User,
        incoming_message: Any,
        session: IMPrivateSession | None,
        kind: SelectionKind | None,
    ) -> bool:
        if not self._interaction_template_id:
            return False
        space = DingTalkCardSpace.from_message(incoming_message)
        state = DingTalkSelectionCardState(
            card_type="interaction",
            channel_id=self._channel_id,
            interaction_template_id=self._interaction_template_id,
            actor_staff_id=str(getattr(incoming_message, "sender_staff_id", "") or ""),
            user_id=user.id,
            conversation_id=str(getattr(incoming_message, "conversation_id", "") or ""),
            conversation_type="group" if space.space_type == "IM_GROUP" else "private",
            space_type=space.space_type,
            space_id=space.space_id,
            session_key=session.session_key if session else "",
            kind=kind.value if kind else "",
        )
        created = await self._create_interaction_card(db, user, state)
        if created and session is not None:
            await im_session_service.cancel_pending(db, session=session)
        return created

    @trace_async(
        span_name="dingtalk.selection_card.callback",
        tracer_name="backend.channels.dingtalk",
    )
    async def handle_callback(self, message: CardCallbackMessage) -> dict[str, Any]:
        out_track_id = str(message.card_instance_id or "")
        state = await _get_state(out_track_id)
        if state is None:
            return self._private_response("设置入口已过期，请发送“设置”重新打开。")

        actor = str(message.user_id or "")
        if not actor or actor != state.actor_staff_id:
            return self._private_response("仅发起该会话设置的用户可以操作。")

        params = self._callback_params(message)
        action = str(params.get("action") or "")
        if state.card_type == "conversation":
            return await self._open_from_conversation_card(state, action)

        return await self._handle_interaction_action(
            out_track_id=out_track_id,
            state=state,
            action=action,
            params=params,
        )

    async def _open_from_conversation_card(
        self,
        state: DingTalkSelectionCardState,
        action: str,
    ) -> dict[str, Any]:
        if action != "open_console":
            return self._private_response("不支持的卡片操作。")
        db = SessionLocal()
        db.expire_on_commit = False
        try:
            user = await self._resolve_actor(db, state)
            if user is None:
                return self._private_response("用户未注册，无法打开会话设置。")
            session = await self._load_session(state)
            interaction = DingTalkSelectionCardState(
                **{
                    **state.to_dict(),
                    "card_type": "interaction",
                    "option_values": {},
                    "status": "",
                }
            )
            interaction.session_key = session.session_key if session else ""
            created = await self._create_interaction_card(db, user, interaction)
            if not created:
                return self._private_response("设置卡片发送失败，请发送“设置”重试。")
            return self._private_response("已打开会话设置。")
        finally:
            db.close()

    async def _handle_interaction_action(
        self,
        *,
        out_track_id: str,
        state: DingTalkSelectionCardState,
        action: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        if action == "close":
            await cache_manager.delete(_state_key(out_track_id))
            return self._card_response(self._closed_card_data())

        db = SessionLocal()
        db.expire_on_commit = False
        try:
            user = await self._resolve_actor(db, state)
            if user is None:
                return self._private_response("用户映射已失效，请联系管理员。")
            session = await self._load_session(state)
            await self._update_navigation(state, action, params)
            if action == "open_kind":
                await self._mark_active_card(out_track_id, state)
            if action == "select":
                await self._apply_selection(
                    db=db,
                    user=user,
                    session=session,
                    state=state,
                    out_track_id=out_track_id,
                    token=str(params.get("token") or ""),
                )
            card_data = await self._render(db, user, session, state)
            await _save_state(out_track_id, state, INTERACTION_CARD_TTL_SECONDS)
            return self._card_response(card_data)
        except SelectionError as exc:
            state.status = f"操作失败：{exc}"
            user = await self._resolve_actor(db, state)
            session = await self._load_session(state)
            if user is None:
                return self._private_response(state.status)
            card_data = await self._render(db, user, session, state)
            await _save_state(out_track_id, state, INTERACTION_CARD_TTL_SECONDS)
            return self._card_response(card_data)
        finally:
            db.close()

    async def _update_navigation(
        self,
        state: DingTalkSelectionCardState,
        action: str,
        params: dict[str, Any],
    ) -> None:
        if action == "open_kind":
            kind_value = str(params.get("kind") or "")
            try:
                kind = SelectionKind(kind_value)
            except ValueError as exc:
                raise SelectionError("选择类型无效。") from exc
            if kind == SelectionKind.TASK and state.conversation_type != "private":
                raise SelectionError("群聊不支持切换私人任务。")
            state.kind = kind.value
            state.page = 0
            state.status = ""
        elif action == "page":
            try:
                state.page = max(0, state.page + int(params.get("delta") or 0))
            except (TypeError, ValueError) as exc:
                raise SelectionError("分页参数无效。") from exc
        elif action == "back":
            state.kind = ""
            state.page = 0
            state.option_values = {}
            state.status = ""
        elif action == "refresh":
            state.status = "已刷新。"
        elif action != "select":
            raise SelectionError("不支持的卡片操作。")

    async def _apply_selection(
        self,
        *,
        db: Session,
        user: User,
        session: IMPrivateSession | None,
        state: DingTalkSelectionCardState,
        out_track_id: str,
        token: str,
    ) -> None:
        value = state.option_values.get(token)
        if not value:
            raise SelectionError("选项已过期，请刷新后重新选择。")
        active_card_id = await cache_manager.get(self._active_card_key(state))
        if active_card_id not in {None, out_track_id, out_track_id.encode()}:
            raise SelectionError("这不是最新的选择卡片，请使用最近打开的卡片。")
        action_key = f"{CARD_ACTION_PREFIX}{out_track_id}:{token}"
        if not await cache_manager.setnx(
            action_key,
            "processing",
            expire=INTERACTION_CARD_TTL_SECONDS,
        ):
            raise SelectionError("该选项已经处理，请勿重复点击。")

        try:
            kind = SelectionKind(state.kind)
            result = await self._apply_kind(db, user, session, state, kind, value)
        except Exception:
            await cache_manager.delete(action_key)
            raise

        state.kind = ""
        state.page = 0
        state.option_values = {}
        if result.kind == SelectionKind.AGENT and result.restored_default:
            state.status = f"已恢复默认智能体：{result.selected_label}"
        else:
            prefix = "已是" if not result.changed else "已切换到"
            state.status = (
                f"{prefix}{self._kind_label(result.kind)}：{result.selected_label}"
            )
        if result.kind == SelectionKind.AGENT and result.task_unbound:
            state.status += "。当前任务未修改，下一条消息将进入新任务创建流程。"

    async def _apply_kind(
        self,
        db: Session,
        user: User,
        session: IMPrivateSession | None,
        state: DingTalkSelectionCardState,
        kind: SelectionKind,
        value: str,
    ) -> Any:
        if kind == SelectionKind.MODEL:
            return await channel_selection_service.apply_model(
                db,
                user,
                value,
                default_model_name=self._get_default_model_name(),
            )
        if kind == SelectionKind.DEVICE:
            result = await channel_selection_service.apply_device(
                db,
                user,
                value,
                default_model_name=self._get_default_model_name(),
            )
            if result.changed:
                await self._clear_conversation_task(state, user.id)
            return result
        if kind == SelectionKind.AGENT:
            result = await channel_selection_service.apply_agent(
                db,
                user,
                value,
                default_team=self._next_task_team(db, user.id),
            )
            await self._clear_conversation_task(state, user.id)
            task_unbound = False
            if (
                session is not None
                and session.mode == IMSessionMode.TASK
                and session.active_task_id is not None
            ):
                await im_session_service.clear_active_task(db, session=session)
                task_unbound = True
            return SelectionApplyResult(
                kind=result.kind,
                selected_label=result.selected_label,
                changed=result.changed,
                detail=result.detail,
                restored_default=result.restored_default,
                task_unbound=task_unbound,
            )
        if session is None:
            raise SelectionError("任务只能在私聊会话中切换。")
        return await channel_selection_service.apply_task(db, user, session, value)

    async def _create_interaction_card(
        self,
        db: Session,
        user: User,
        state: DingTalkSelectionCardState,
    ) -> bool:
        session = await self._load_session(state)
        card_data = await self._render(db, user, session, state)
        out_track_id = self._transport.new_out_track_id()
        await _save_state(out_track_id, state, INTERACTION_CARD_TTL_SECONDS)
        if state.kind:
            await self._mark_active_card(out_track_id, state)
        created = await self._transport.create_and_deliver(
            out_track_id=out_track_id,
            template_id=state.interaction_template_id,
            space=state.space,
            card_data=card_data,
        )
        if not created:
            await cache_manager.delete(_state_key(out_track_id))
            if state.kind:
                await cache_manager.delete(self._active_card_key(state))
        return created

    async def _render(
        self,
        db: Session,
        user: User,
        session: IMPrivateSession | None,
        state: DingTalkSelectionCardState,
    ) -> dict[str, Any]:
        model_options = await channel_selection_service.list_models(
            db,
            user,
            default_model_name=self._get_default_model_name(),
        )
        device_options = await channel_selection_service.list_devices(db, user)
        default_team = self._next_task_team(db, user.id)
        agent_options = await channel_selection_service.list_agents(
            db,
            user,
            include_default=True,
            default_team=default_team,
        )
        task_options = (
            await channel_selection_service.list_tasks(db, user, session)
            if session is not None
            else []
        )
        card_data: dict[str, Any] = {
            "title": "会话设置",
            "view": "console" if not state.kind else "options",
            "status": state.status,
            "currentModel": self._current_label(
                model_options,
                self._get_default_model_name() or "默认模型",
            ),
            "currentDevice": await self._current_device_label(user.id, device_options),
            "currentTask": self._current_task_label(session, task_options),
            "currentTaskAgent": self._current_task_agent_label(db, user, session),
            "nextTaskAgent": await self._next_task_agent_label(
                db,
                user,
                default_team,
            ),
            "showAgent": True,
            "showTask": state.conversation_type == "private",
            "kind": state.kind,
            "kindLabel": "",
            "options": [],
            "pageLabel": "",
            "showPrevious": False,
            "showNext": False,
        }
        if state.kind:
            kind = SelectionKind(state.kind)
            options = self._options_for_kind(
                kind,
                model_options,
                device_options,
                agent_options,
                task_options,
            )
            card_data.update(self._render_options(state, kind, options))
        return card_data

    def _render_options(
        self,
        state: DingTalkSelectionCardState,
        kind: SelectionKind,
        options: list[SelectionOption],
    ) -> dict[str, Any]:
        page_count = max(1, (len(options) + PAGE_SIZE - 1) // PAGE_SIZE)
        state.page = min(state.page, page_count - 1)
        start = state.page * PAGE_SIZE
        visible = options[start : start + PAGE_SIZE]
        state.option_values = {}
        payload = []
        for option in visible:
            token = secrets.token_urlsafe(9)
            state.option_values[token] = option.value
            payload.append(
                {
                    "token": token,
                    "label": option.label,
                    "description": option.description,
                    "current": option.is_current,
                    "disabled": option.is_disabled or option.is_current,
                }
            )
        return {
            "kindLabel": f"选择{self._kind_label(kind)}",
            "options": payload,
            "pageLabel": f"{state.page + 1}/{page_count}" if page_count > 1 else "",
            "showPrevious": state.page > 0,
            "showNext": state.page + 1 < page_count,
        }

    async def _resolve_actor(
        self,
        db: Session,
        state: DingTalkSelectionCardState,
    ) -> User | None:
        config = self._get_user_mapping_config()
        if isinstance(config, dict):
            mode = str(config.get("mode") or "select_user")
            mapping = config.get("config")
        else:
            mode = str(getattr(config, "mode", None) or "select_user")
            mapping = getattr(config, "config", None)
        resolver = DingTalkUserResolver(
            db,
            user_mapping_mode=mode,
            user_mapping_config=mapping,
        )
        user = await resolver.resolve_user(
            sender_id=state.actor_staff_id,
            sender_nick=None,
            sender_staff_id=state.actor_staff_id,
        )
        if user is None or user.id != state.user_id:
            return None
        return user

    async def _load_session(
        self,
        state: DingTalkSelectionCardState,
    ) -> IMPrivateSession | None:
        if not state.session_key:
            return None
        session = await im_session_service.get_session(state.session_key)
        if session is None or session.user_id != state.user_id:
            return None
        return session

    async def _current_device_label(
        self,
        user_id: int,
        options: list[SelectionOption],
    ) -> str:
        current = self._current_label(options, "")
        if current:
            return current
        selection = await device_selection_manager.get_selection(user_id)
        if selection.device_type == DeviceType.CLOUD:
            return "云端执行"
        if selection.device_type == DeviceType.LOCAL:
            return selection.device_name or "离线设备"
        return "对话模式"

    def _current_task_label(
        self,
        session: IMPrivateSession | None,
        options: list[SelectionOption],
    ) -> str:
        if session is None:
            return ""
        current = self._current_label(options, "")
        if current:
            return current
        return f"任务 {session.active_task_id}" if session.active_task_id else "未绑定"

    def _options_for_kind(
        self,
        kind: SelectionKind,
        models: list[SelectionOption],
        devices: list[SelectionOption],
        agents: list[SelectionOption],
        tasks: list[SelectionOption],
    ) -> list[SelectionOption]:
        if kind == SelectionKind.MODEL:
            return models
        if kind == SelectionKind.DEVICE:
            return devices
        if kind == SelectionKind.AGENT:
            return agents
        return tasks

    def _next_task_team(self, db: Session, user_id: int) -> Kind | None:
        from app.services.channels.team_selection import resolve_task_mode_team

        return resolve_task_mode_team(
            db,
            user_id,
            default_team_id=self._get_default_team_id(),
        )

    async def _next_task_agent_label(
        self,
        db: Session,
        user: User,
        default_team: Kind | None,
    ) -> str:
        from app.services.channels.team_selection import (
            get_team_display_name,
            resolve_selected_team,
        )

        selected = await resolve_selected_team(db, user.id)
        label = get_team_display_name(selected or default_team)
        return f"{label}（用户选择）" if selected is not None else label

    def _current_task_agent_label(
        self,
        db: Session,
        user: User,
        session: IMPrivateSession | None,
    ) -> str:
        if session is None or session.mode != IMSessionMode.TASK:
            return ""
        if session.active_task_id is None:
            return "本地运行任务" if session.active_runtime_task else "未绑定"

        from app.services.channels.team_selection import get_team_display_name
        from app.services.im import task_continuation_service as task_service

        try:
            task = task_service.validate_personal_wework_task(
                db,
                user.id,
                session.active_task_id,
            )
            return get_team_display_name(task_service.get_task_team(db, task))
        except Exception:
            logger.warning(
                "[DingTalkSelectionCard] Failed to resolve active Task Team: "
                "user_id=%s, task_id=%s",
                user.id,
                session.active_task_id,
                exc_info=True,
            )
            return "任务不可用"

    def _current_label(self, options: list[SelectionOption], fallback: str) -> str:
        current = next((option.label for option in options if option.is_current), "")
        return current or fallback

    async def _clear_conversation_task(
        self,
        state: DingTalkSelectionCardState,
        user_id: int,
    ) -> None:
        key = f"channel:conv_task:dingtalk:{state.conversation_id}:{user_id}"
        await cache_manager.delete(key)

    async def _mark_active_card(
        self,
        out_track_id: str,
        state: DingTalkSelectionCardState,
    ) -> None:
        await cache_manager.set(
            self._active_card_key(state),
            out_track_id,
            expire=INTERACTION_CARD_TTL_SECONDS,
        )

    def _active_card_key(self, state: DingTalkSelectionCardState) -> str:
        scope = (
            state.session_key
            if state.kind == SelectionKind.TASK.value
            else state.user_id
        )
        return f"{ACTIVE_CARD_PREFIX}{scope}:{state.kind}"

    def _callback_params(self, message: CardCallbackMessage) -> dict[str, Any]:
        content = message.content if isinstance(message.content, dict) else {}
        private_data = content.get("cardPrivateData")
        if not isinstance(private_data, dict):
            return {}
        params = private_data.get("params")
        return params if isinstance(params, dict) else {}

    def _kind_label(self, kind: SelectionKind) -> str:
        return {
            SelectionKind.MODEL: "模型",
            SelectionKind.DEVICE: "设备",
            SelectionKind.AGENT: "智能体",
            SelectionKind.TASK: "任务",
        }[kind]

    def _closed_card_data(self) -> dict[str, Any]:
        return {
            "title": "会话设置",
            "view": "closed",
            "status": "设置已关闭。发送“设置”可重新打开。",
            "showTask": False,
            "options": [],
        }

    def _card_response(self, card_data: dict[str, Any]) -> dict[str, Any]:
        return {
            "cardUpdateOptions": {
                "updateCardDataByKey": True,
                "updatePrivateDataByKey": True,
            },
            "cardData": {"cardParamMap": stringify_card_data(card_data)},
            "userPrivateData": {"cardParamMap": {}},
        }

    def _private_response(self, status: str) -> dict[str, Any]:
        return {
            "cardUpdateOptions": {
                "updateCardDataByKey": False,
                "updatePrivateDataByKey": True,
            },
            "cardData": {"cardParamMap": {}},
            "userPrivateData": {
                "cardParamMap": stringify_card_data({"status": status})
            },
        }


class DingTalkSelectionCardCallbackHandler(dingtalk_stream.CallbackHandler):
    """Stream callback adapter for selection-card actions."""

    def __init__(self, service: DingTalkSelectionCardService) -> None:
        super().__init__()
        self._service = service

    async def process(self, callback: CallbackMessage) -> tuple[str, Any]:
        try:
            message = CardCallbackMessage.from_dict(callback.data)
            response = await self._service.handle_callback(message)
            return AckMessage.STATUS_OK, response
        except Exception:
            logger.exception("[DingTalkSelectionCard] Callback processing failed")
            return AckMessage.STATUS_SYSTEM_EXCEPTION, {
                "message": "会话设置暂时不可用，请稍后重试。"
            }


def selection_kind_for_message(content: str) -> SelectionKind | None | bool:
    """Return a requested kind, None for console, or False for no card intent."""

    command = parse_command(content)
    if command is None or command.argument:
        return False
    if command.command == CommandType.MODELS:
        return SelectionKind.MODEL
    if command.command == CommandType.DEVICES:
        return SelectionKind.DEVICE
    if command.command == CommandType.AGENTS:
        return SelectionKind.AGENT
    if command.command == CommandType.SWITCH:
        return SelectionKind.TASK
    if command.command == CommandType.STATUS:
        return None
    return False


def _state_key(out_track_id: str) -> str:
    return f"{CARD_STATE_PREFIX}{out_track_id}"


async def _save_state(
    out_track_id: str,
    state: DingTalkSelectionCardState,
    ttl: int,
) -> None:
    await cache_manager.set(_state_key(out_track_id), state.to_dict(), expire=ttl)


async def _get_state(out_track_id: str) -> DingTalkSelectionCardState | None:
    return DingTalkSelectionCardState.from_dict(
        await cache_manager.get(_state_key(out_track_id))
    )
