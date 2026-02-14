# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Extended event emitter for non-task-execution events.

This module provides ExtendedEventEmitter class for emitting events that are
not part of the core task execution flow (which should go through ExecutionDispatcher).

Events handled by this emitter:
- task:invited - User invited to group chat
- task:shared - Task shared with user
- task:deleted - Task deleted
- task:renamed - Task renamed
- task:app_update - App preview available
- correction:* - Correction events
- skill:request - Skill request events
- pet:* - Pet experience and evolution events

Note: Chat streaming events (chat:start, chat:chunk, chat:done, chat:error,
chat:cancelled) and task:status should go through ExecutionDispatcher,
not this emitter.
"""

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


class ExtendedEventEmitter:
    """
    Extended event emitter for non-task-execution events.

    This class provides methods for emitting events that are not part of
    the core task execution flow (which should go through ExecutionDispatcher).

    Events handled by this emitter:
    - task:invited - User invited to group chat
    - task:shared - Task shared with user
    - task:deleted - Task deleted
    - task:renamed - Task renamed
    - task:app_update - App preview available
    - correction:* - Correction events
    - skill:request - Skill request events
    - pet:* - Pet experience and evolution events

    Note: Chat streaming events (chat:start, chat:chunk, chat:done, chat:error,
    chat:cancelled) and task:status should go through ExecutionDispatcher,
    not this emitter.
    """

    def _get_ws_emitter(self):
        """Get the WebSocket emitter instance.

        Returns:
            WebSocketEmitter or None if not initialized
        """
        from app.services.chat.webpage_ws_chat_emitter import _get_ws_emitter

        return _get_ws_emitter()

    # ============================================================
    # Task Lifecycle Events
    # ============================================================

    async def emit_task_invited(
        self,
        user_id: int,
        task_id: int,
        title: str,
        team_id: int,
        team_name: str,
        invited_by: Dict[str, Any],
    ) -> None:
        """
        Emit task:invited event to user room when user is invited to a group chat.

        Args:
            user_id: Target user ID (who is invited)
            task_id: Task ID
            title: Task title
            team_id: Team ID
            team_name: Team name
            invited_by: Info about who invited the user
        """
        ws_emitter = self._get_ws_emitter()
        if not ws_emitter:
            logger.warning(
                "[ExtendedEmitter] Cannot emit task:invited - emitter not initialized"
            )
            return
        await ws_emitter.emit_task_invited(
            user_id=user_id,
            task_id=task_id,
            title=title,
            team_id=team_id,
            team_name=team_name,
            invited_by=invited_by,
        )

    async def emit_task_shared(
        self,
        user_id: int,
        task_id: int,
        title: str,
        shared_by: Dict[str, Any],
    ) -> None:
        """
        Emit task:shared event to user room.

        Args:
            user_id: Target user ID (who receives the shared task)
            task_id: Task ID
            title: Task title
            shared_by: Info about who shared the task
        """
        ws_emitter = self._get_ws_emitter()
        if not ws_emitter:
            logger.warning(
                "[ExtendedEmitter] Cannot emit task:shared - emitter not initialized"
            )
            return
        await ws_emitter.emit_task_shared(
            user_id=user_id,
            task_id=task_id,
            title=title,
            shared_by=shared_by,
        )

    async def emit_task_deleted(self, user_id: int, task_id: int) -> None:
        """
        Emit task:deleted event to user room.

        Args:
            user_id: User ID
            task_id: Task ID
        """
        ws_emitter = self._get_ws_emitter()
        if not ws_emitter:
            logger.warning(
                "[ExtendedEmitter] Cannot emit task:deleted - emitter not initialized"
            )
            return
        await ws_emitter.emit_task_deleted(user_id=user_id, task_id=task_id)

    async def emit_task_renamed(self, user_id: int, task_id: int, title: str) -> None:
        """
        Emit task:renamed event to user room.

        Args:
            user_id: User ID
            task_id: Task ID
            title: New title
        """
        ws_emitter = self._get_ws_emitter()
        if not ws_emitter:
            logger.warning(
                "[ExtendedEmitter] Cannot emit task:renamed - emitter not initialized"
            )
            return
        await ws_emitter.emit_task_renamed(
            user_id=user_id, task_id=task_id, title=title
        )

    async def emit_task_app_update(
        self,
        task_id: int,
        app: Dict[str, Any],
    ) -> None:
        """
        Emit task:app_update event to task room.

        This notifies clients viewing this task about app data changes.
        Used by expose_service tool when app preview becomes available.

        Args:
            task_id: Task ID
            app: App data (name, address, previewUrl)
        """
        ws_emitter = self._get_ws_emitter()
        if not ws_emitter:
            logger.warning(
                "[ExtendedEmitter] Cannot emit task:app_update - emitter not initialized"
            )
            return
        await ws_emitter.emit_task_app_update(task_id=task_id, app=app)

    async def emit_group_chat_new_message(
        self,
        user_id: int,
        task_id: int,
        status: str,
        progress: int = 0,
    ) -> None:
        """
        Notify a group chat member about a new message in the task.

        This sends a task:status event to the user's room so their task list
        can show the unread indicator for new messages.

        Args:
            user_id: Target user ID to notify
            task_id: Task ID where the new message was posted
            status: Current task status (e.g., "PENDING", "COMPLETED")
            progress: Task progress percentage (0-100)
        """
        ws_emitter = self._get_ws_emitter()
        if not ws_emitter:
            logger.warning(
                "[ExtendedEmitter] Cannot emit group chat new message - emitter not initialized"
            )
            return
        await ws_emitter.emit_task_status(
            user_id=user_id,
            task_id=task_id,
            status=status,
            progress=progress,
        )
        logger.debug(
            f"[ExtendedEmitter] emit group_chat_new_message user={user_id} task={task_id}"
        )

    # ============================================================
    # Correction Events
    # ============================================================

    async def emit_correction_start(
        self,
        task_id: int,
        subtask_id: int,
        correction_model: str,
    ) -> None:
        """
        Emit correction:start event to task room.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID (AI message being corrected)
            correction_model: Model ID used for correction
        """
        ws_emitter = self._get_ws_emitter()
        if not ws_emitter:
            logger.warning(
                "[ExtendedEmitter] Cannot emit correction:start - emitter not initialized"
            )
            return
        await ws_emitter.emit_correction_start(
            task_id=task_id,
            subtask_id=subtask_id,
            correction_model=correction_model,
        )

    async def emit_correction_progress(
        self,
        task_id: int,
        subtask_id: int,
        stage: str,
        tool_name: Optional[str] = None,
    ) -> None:
        """
        Emit correction:progress event to task room.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            stage: Current stage (verifying_facts, evaluating, generating_improvement)
            tool_name: Optional tool name being used
        """
        ws_emitter = self._get_ws_emitter()
        if not ws_emitter:
            logger.warning(
                "[ExtendedEmitter] Cannot emit correction:progress - emitter not initialized"
            )
            return
        await ws_emitter.emit_correction_progress(
            task_id=task_id,
            subtask_id=subtask_id,
            stage=stage,
            tool_name=tool_name,
        )

    async def emit_correction_chunk(
        self,
        task_id: int,
        subtask_id: int,
        field: str,
        content: str,
        offset: int,
    ) -> None:
        """
        Emit correction:chunk event to task room for streaming content.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            field: Field being streamed (summary or improved_answer)
            content: Content chunk
            offset: Current offset
        """
        ws_emitter = self._get_ws_emitter()
        if not ws_emitter:
            logger.warning(
                "[ExtendedEmitter] Cannot emit correction:chunk - emitter not initialized"
            )
            return
        await ws_emitter.emit_correction_chunk(
            task_id=task_id,
            subtask_id=subtask_id,
            field=field,
            content=content,
            offset=offset,
        )

    async def emit_correction_done(
        self,
        task_id: int,
        subtask_id: int,
        result: Dict[str, Any],
    ) -> None:
        """
        Emit correction:done event to task room.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            result: Correction result data
        """
        ws_emitter = self._get_ws_emitter()
        if not ws_emitter:
            logger.warning(
                "[ExtendedEmitter] Cannot emit correction:done - emitter not initialized"
            )
            return
        await ws_emitter.emit_correction_done(
            task_id=task_id,
            subtask_id=subtask_id,
            result=result,
        )

    async def emit_correction_error(
        self,
        task_id: int,
        subtask_id: int,
        error: str,
    ) -> None:
        """
        Emit correction:error event to task room.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            error: Error message
        """
        ws_emitter = self._get_ws_emitter()
        if not ws_emitter:
            logger.warning(
                "[ExtendedEmitter] Cannot emit correction:error - emitter not initialized"
            )
            return
        await ws_emitter.emit_correction_error(
            task_id=task_id,
            subtask_id=subtask_id,
            error=error,
        )

    # ============================================================
    # Skill Events
    # ============================================================

    async def emit_skill_request(
        self,
        task_id: int,
        request_id: str,
        skill_name: str,
        action: str,
        data: Dict[str, Any],
    ) -> None:
        """
        Emit a generic skill request to frontend.

        Args:
            task_id: Task ID (used to determine the room)
            request_id: Unique identifier for this request
            skill_name: Name of the skill
            action: Action to perform (e.g., "render")
            data: Skill-specific data payload
        """
        ws_emitter = self._get_ws_emitter()
        if not ws_emitter:
            logger.warning(
                "[ExtendedEmitter] Cannot emit skill:request - emitter not initialized"
            )
            return
        await ws_emitter.emit_skill_request(
            task_id=task_id,
            request_id=request_id,
            skill_name=skill_name,
            action=action,
            data=data,
        )

    # ============================================================
    # Pet Events
    # ============================================================

    async def emit_pet_experience_gained(
        self,
        user_id: int,
        amount: int,
        total: int,
        source: str,
        multiplier: float = 1.0,
    ) -> None:
        """
        Emit pet:experience_gained event to user room.

        Args:
            user_id: User ID
            amount: Amount of experience gained
            total: Total experience after gain
            source: Source of experience gain (chat, memory, streak_bonus)
            multiplier: Multiplier applied to the base experience
        """
        from app.api.ws.events import ServerEvents
        from app.services.chat.webpage_ws_chat_emitter import safe_emit_in_main_loop

        ws_emitter = self._get_ws_emitter()
        if not ws_emitter:
            logger.warning(
                "[ExtendedEmitter] Cannot emit pet:experience_gained - emitter not initialized"
            )
            return

        await safe_emit_in_main_loop(
            ws_emitter.sio.emit,
            ServerEvents.PET_EXPERIENCE_GAINED,
            {
                "amount": amount,
                "total": total,
                "source": source,
                "multiplier": multiplier,
            },
            room=f"user:{user_id}",
            namespace=ws_emitter.namespace,
        )
        logger.debug(
            f"[ExtendedEmitter] emit pet:experience_gained user={user_id} amount={amount} total={total} source={source}"
        )

    async def emit_pet_stage_evolved(
        self,
        user_id: int,
        old_stage: int,
        new_stage: int,
        old_stage_name: str,
        new_stage_name: str,
    ) -> None:
        """
        Emit pet:stage_evolved event to user room.

        Args:
            user_id: User ID
            old_stage: Previous evolution stage
            new_stage: New evolution stage
            old_stage_name: Previous stage name
            new_stage_name: New stage name
        """
        from app.api.ws.events import ServerEvents
        from app.services.chat.webpage_ws_chat_emitter import safe_emit_in_main_loop

        ws_emitter = self._get_ws_emitter()
        if not ws_emitter:
            logger.warning(
                "[ExtendedEmitter] Cannot emit pet:stage_evolved - emitter not initialized"
            )
            return

        await safe_emit_in_main_loop(
            ws_emitter.sio.emit,
            ServerEvents.PET_STAGE_EVOLVED,
            {
                "old_stage": old_stage,
                "new_stage": new_stage,
                "old_stage_name": old_stage_name,
                "new_stage_name": new_stage_name,
            },
            room=f"user:{user_id}",
            namespace=ws_emitter.namespace,
        )
        logger.info(
            f"[ExtendedEmitter] emit pet:stage_evolved user={user_id} {old_stage_name} -> {new_stage_name}"
        )

    async def emit_pet_traits_updated(
        self,
        user_id: int,
        traits: Dict[str, Any],
    ) -> None:
        """
        Emit pet:traits_updated event to user room.

        Args:
            user_id: User ID
            traits: Updated appearance traits
        """
        from app.api.ws.events import ServerEvents
        from app.services.chat.webpage_ws_chat_emitter import safe_emit_in_main_loop

        ws_emitter = self._get_ws_emitter()
        if not ws_emitter:
            logger.warning(
                "[ExtendedEmitter] Cannot emit pet:traits_updated - emitter not initialized"
            )
            return

        await safe_emit_in_main_loop(
            ws_emitter.sio.emit,
            ServerEvents.PET_TRAITS_UPDATED,
            {
                "traits": traits,
            },
            room=f"user:{user_id}",
            namespace=ws_emitter.namespace,
        )
        logger.info(
            f"[ExtendedEmitter] emit pet:traits_updated user={user_id} traits={traits}"
        )


# Global ExtendedEventEmitter instance
_extended_emitter = ExtendedEventEmitter()


def get_extended_emitter() -> ExtendedEventEmitter:
    """
    Get the global ExtendedEventEmitter instance.

    This is the recommended way to emit non-task-execution events.
    For task execution events (chat:start, chat:chunk, etc.), use
    the ExecutionDispatcher instead.

    Returns:
        ExtendedEventEmitter instance
    """
    return _extended_emitter
