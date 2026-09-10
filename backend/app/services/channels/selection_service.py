# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Provider-neutral model, device, and private-task selection operations."""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Sequence

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.im_session import IMPrivateSession
from app.models.user import User
from app.services.channels.device_selection import (
    DeviceType,
    device_selection_manager,
    get_device_execution_target_id,
)
from app.services.channels.model_selection import (
    ModelSelection,
    is_claude_provider,
    model_selection_manager,
)
from app.services.im import task_continuation_service as task_service
from app.services.im.session_service import im_session_service


class SelectionKind(str, Enum):
    """Resource kinds exposed by an IM selection surface."""

    MODEL = "model"
    DEVICE = "device"
    TASK = "task"


class SelectionError(ValueError):
    """A user-visible selection validation error."""


@dataclass(frozen=True)
class SelectionOption:
    """One provider-neutral selection option."""

    value: str
    label: str
    description: str = ""
    is_current: bool = False
    is_disabled: bool = False
    aliases: tuple[str, ...] = field(default_factory=tuple, repr=False)
    prefix_aliases: tuple[str, ...] = field(default_factory=tuple, repr=False)


@dataclass(frozen=True)
class SelectionApplyResult:
    """Result returned after a selection is revalidated and applied."""

    kind: SelectionKind
    selected_label: str
    changed: bool
    detail: str = ""


def resolve_text_choice(
    options: Sequence[SelectionOption], argument: str
) -> SelectionOption | None:
    """Resolve a legacy command index, label, or alias against current options."""

    normalized = argument.strip().lower()
    if normalized.isdigit():
        index = int(normalized)
        return options[index - 1] if 1 <= index <= len(options) else None

    for option in options:
        candidates = (option.label, option.value, *option.aliases)
        if any(candidate.strip().lower() == normalized for candidate in candidates):
            return option
        if any(
            candidate.strip().lower().startswith(normalized)
            for candidate in option.prefix_aliases
        ):
            return option
    return None


class ChannelSelectionService:
    """List and apply selections shared by text commands and rich cards."""

    async def list_models(
        self,
        db: Session,
        user: User,
        *,
        default_model_name: str | None = None,
    ) -> list[SelectionOption]:
        models = self._available_models(db, user)
        current = await model_selection_manager.get_selection(user.id)
        device = await device_selection_manager.get_selection(user.id)
        is_device_mode = device.device_type == DeviceType.LOCAL

        return [
            self._model_option(
                model,
                current=current,
                default_model_name=default_model_name,
                is_device_mode=is_device_mode,
            )
            for model in models
        ]

    async def apply_model(
        self,
        db: Session,
        user: User,
        value: str,
        *,
        default_model_name: str | None = None,
    ) -> SelectionApplyResult:
        options = await self.list_models(
            db,
            user,
            default_model_name=default_model_name,
        )
        option = self._option_by_value(options, value, SelectionKind.MODEL)
        if option.is_disabled:
            raise SelectionError("该模型不支持当前设备模式，请选择 Claude 模型。")

        model_type, model_name = self._split_model_value(option.value)
        model = next(
            (
                item
                for item in self._available_models(db, user)
                if str(item.get("name") or "") == model_name
                and str(item.get("type") or "public") == model_type
            ),
            None,
        )
        if model is None:
            raise SelectionError("模型已不可用，请刷新后重新选择。")

        current = await model_selection_manager.get_selection(user.id)
        changed = not current or (
            current.model_name != model_name or current.model_type != model_type
        )
        await model_selection_manager.set_selection(
            user.id,
            ModelSelection(
                model_name=model_name,
                model_type=model_type,
                display_name=model.get("displayName"),
                provider=model.get("provider"),
            ),
        )
        return SelectionApplyResult(SelectionKind.MODEL, option.label, changed)

    async def list_devices(
        self,
        db: Session,
        user: User,
    ) -> list[SelectionOption]:
        from app.services.device_service import device_service

        devices = await device_service.get_all_devices(db, user.id)
        current = await device_selection_manager.get_selection(user.id)
        current_id = (
            current.device_id if current.device_type == DeviceType.LOCAL else None
        )
        return [self._device_option(device, current_id) for device in devices]

    async def apply_device(
        self,
        db: Session,
        user: User,
        value: str,
        *,
        default_model_name: str | None = None,
    ) -> SelectionApplyResult:
        options = await self.list_devices(db, user)
        option = self._option_by_value(options, value, SelectionKind.DEVICE)
        if option.is_disabled:
            raise SelectionError("设备已离线，请刷新后选择其他设备。")

        model_label = await self._device_model_label(
            db, user, default_model_name=default_model_name
        )
        current = await device_selection_manager.get_selection(user.id)
        changed = current.device_type != DeviceType.LOCAL or current.device_id != value
        await device_selection_manager.set_local_device(user.id, value, option.label)
        return SelectionApplyResult(
            SelectionKind.DEVICE,
            option.label,
            changed,
            detail=f"当前模型：{model_label}",
        )

    async def list_tasks(
        self,
        db: Session,
        user: User,
        session: IMPrivateSession,
    ) -> list[SelectionOption]:
        tasks = task_service.list_recent_wework_tasks(db, user.id, limit=5)
        return [
            SelectionOption(
                value=str(task["id"]),
                label=str(task.get("title") or f"任务 {task['id']}"),
                description=f"任务 {task['id']}",
                is_current=session.active_task_id == task["id"],
                aliases=(str(task["id"]),),
            )
            for task in tasks
        ]

    async def apply_task(
        self,
        db: Session,
        user: User,
        session: IMPrivateSession,
        value: str,
    ) -> SelectionApplyResult:
        try:
            task_id = int(value)
        except (TypeError, ValueError) as exc:
            raise SelectionError("任务选择无效，请刷新后重新选择。") from exc

        try:
            task = task_service.validate_personal_wework_task(db, user.id, task_id)
        except Exception as exc:
            raise SelectionError("任务已不可用，请刷新后重新选择。") from exc

        changed = session.active_task_id != task_id
        await im_session_service.bind_active_task(db, session=session, task_id=task_id)
        return SelectionApplyResult(
            SelectionKind.TASK,
            task_service.get_task_title(task),
            changed,
        )

    def _available_models(self, db: Session, user: User) -> list[dict[str, Any]]:
        from app.services.model_aggregation_service import model_aggregation_service

        return model_aggregation_service.list_available_models(
            db=db,
            current_user=user,
            shell_type=None,
            include_config=False,
            scope="personal",
            model_category_type="llm",
        )

    def _model_option(
        self,
        model: dict[str, Any],
        *,
        current: ModelSelection | None,
        default_model_name: str | None,
        is_device_mode: bool,
    ) -> SelectionOption:
        name = str(model.get("name") or "")
        model_type = str(model.get("type") or "public")
        display_name = str(model.get("displayName") or name)
        provider = str(model.get("provider") or "未知")
        is_current = (
            current.model_name == name and current.model_type == model_type
            if current
            else name == (default_model_name or "")
        )
        return SelectionOption(
            value=self._model_value(model_type, name),
            label=display_name,
            description=provider,
            is_current=is_current,
            is_disabled=is_device_mode and not is_claude_provider(provider),
            aliases=(name, display_name),
        )

    def _device_option(
        self,
        device: dict[str, Any],
        current_id: str | None,
    ) -> SelectionOption:
        target_id = get_device_execution_target_id(device)
        status = str(device.get("status") or "offline")
        label = str(device.get("name") or device.get("device_id") or target_id)
        status_label = {"offline": "离线", "busy": "忙碌"}.get(status, "在线")
        logical_id = str(device.get("device_id") or "")
        return SelectionOption(
            value=target_id,
            label=label,
            description=status_label,
            is_current=target_id == current_id,
            is_disabled=status == "offline",
            aliases=(logical_id, label, target_id),
            prefix_aliases=(logical_id, target_id),
        )

    async def _device_model_label(
        self,
        db: Session,
        user: User,
        *,
        default_model_name: str | None,
    ) -> str:
        models = self._available_models(db, user)
        current = await model_selection_manager.get_selection(user.id)
        selected = self._find_selected_model(models, current)
        if selected and is_claude_provider(selected.get("provider")):
            return str(selected.get("displayName") or selected.get("name"))

        configured_default = settings.IM_CHANNEL_DEVICE_DEFAULT_MODEL.strip()
        configured_default = configured_default or (default_model_name or "").strip()
        fallback = self._find_model_by_name(models, configured_default)
        if fallback and is_claude_provider(fallback.get("provider")):
            return str(fallback.get("displayName") or fallback.get("name"))

        raise SelectionError("设备模式仅支持 Claude 模型，请先切换模型。")

    def _find_selected_model(
        self,
        models: Sequence[dict[str, Any]],
        current: ModelSelection | None,
    ) -> dict[str, Any] | None:
        if not current:
            return None
        return next(
            (
                item
                for item in models
                if str(item.get("name") or "") == current.model_name
                and str(item.get("type") or "public") == current.model_type
            ),
            None,
        )

    def _find_model_by_name(
        self,
        models: Sequence[dict[str, Any]],
        name: str,
    ) -> dict[str, Any] | None:
        if not name:
            return None
        return next(
            (
                item
                for item in models
                if name
                in {
                    str(item.get("name") or ""),
                    str(item.get("displayName") or ""),
                }
            ),
            None,
        )

    def _option_by_value(
        self,
        options: Sequence[SelectionOption],
        value: str,
        kind: SelectionKind,
    ) -> SelectionOption:
        option = next((item for item in options if item.value == value), None)
        if option is None:
            labels = {SelectionKind.MODEL: "模型", SelectionKind.DEVICE: "设备"}
            raise SelectionError(f"{labels.get(kind, '选项')}已不可用，请刷新后重试。")
        return option

    def _model_value(self, model_type: str, name: str) -> str:
        return f"{model_type}\0{name}"

    def _split_model_value(self, value: str) -> tuple[str, str]:
        parts = value.split("\0", 1)
        if len(parts) != 2 or not all(parts):
            raise SelectionError("模型选择无效，请刷新后重新选择。")
        return parts[0], parts[1]


channel_selection_service = ChannelSelectionService()
