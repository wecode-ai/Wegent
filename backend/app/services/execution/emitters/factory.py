# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Result emitter factory.

Creates appropriate emitter instances based on configuration.
"""

import logging
from enum import Enum
from typing import List

from .callback import BatchCallbackEmitter, CallbackResultEmitter
from .composite import CompositeResultEmitter
from .protocol import ResultEmitter
from .sse import SSEResultEmitter
from .websocket import WebSocketResultEmitter

logger = logging.getLogger(__name__)


class EmitterType(str, Enum):
    """Emitter types."""

    WEBSOCKET = "websocket"
    SSE = "sse"
    CALLBACK = "callback"
    BATCH_CALLBACK = "batch_callback"


class ResultEmitterFactory:
    """Result emitter factory.

    Creates appropriate emitter instances based on configuration.
    """

    @staticmethod
    def create(
        emitter_type: EmitterType,
        task_id: int,
        subtask_id: int,
        **kwargs,
    ) -> ResultEmitter:
        """Create a single emitter.

        Args:
            emitter_type: Type of emitter to create
            task_id: Task ID
            subtask_id: Subtask ID
            **kwargs: Additional parameters for the emitter

        Returns:
            ResultEmitter instance

        Raises:
            ValueError: If emitter type is unknown
        """
        if emitter_type == EmitterType.WEBSOCKET:
            return WebSocketResultEmitter(
                task_id=task_id,
                subtask_id=subtask_id,
                user_id=kwargs.get("user_id"),
            )

        elif emitter_type == EmitterType.SSE:
            return SSEResultEmitter(
                task_id=task_id,
                subtask_id=subtask_id,
                format_sse=kwargs.get("format_sse", True),
            )

        elif emitter_type == EmitterType.CALLBACK:
            callback_url = kwargs.get("callback_url")
            if not callback_url:
                raise ValueError("callback_url is required for CALLBACK emitter")
            return CallbackResultEmitter(
                task_id=task_id,
                subtask_id=subtask_id,
                callback_url=callback_url,
                timeout=kwargs.get("timeout", 30.0),
                headers=kwargs.get("headers"),
            )

        elif emitter_type == EmitterType.BATCH_CALLBACK:
            callback_url = kwargs.get("callback_url")
            if not callback_url:
                raise ValueError("callback_url is required for BATCH_CALLBACK emitter")
            return BatchCallbackEmitter(
                task_id=task_id,
                subtask_id=subtask_id,
                callback_url=callback_url,
                batch_size=kwargs.get("batch_size", 10),
                flush_interval=kwargs.get("flush_interval", 1.0),
                timeout=kwargs.get("timeout", 30.0),
                headers=kwargs.get("headers"),
            )

        else:
            raise ValueError(f"Unknown emitter type: {emitter_type}")

    @staticmethod
    def create_composite(
        task_id: int,
        subtask_id: int,
        emitter_configs: List[dict],
    ) -> CompositeResultEmitter:
        """Create a composite emitter.

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            emitter_configs: List of emitter configurations,
                each containing 'type' and other parameters

        Returns:
            CompositeResultEmitter instance
        """
        emitters = []
        for config in emitter_configs:
            config_copy = config.copy()
            emitter_type = EmitterType(config_copy.pop("type"))
            emitter = ResultEmitterFactory.create(
                emitter_type=emitter_type,
                task_id=task_id,
                subtask_id=subtask_id,
                **config_copy,
            )
            emitters.append(emitter)

        return CompositeResultEmitter(emitters)

    @staticmethod
    def create_for_dispatch_mode(
        mode: str,
        task_id: int,
        subtask_id: int,
        **kwargs,
    ) -> ResultEmitter:
        """Create emitter based on dispatch mode.

        Args:
            mode: Dispatch mode - sse, websocket, http_callback
            task_id: Task ID
            subtask_id: Subtask ID
            **kwargs: Additional parameters

        Returns:
            ResultEmitter instance

        Raises:
            ValueError: If dispatch mode is unknown
        """
        mode_mapping = {
            "sse": EmitterType.SSE,
            "websocket": EmitterType.WEBSOCKET,
            "http_callback": EmitterType.CALLBACK,
        }

        emitter_type = mode_mapping.get(mode)
        if not emitter_type:
            raise ValueError(f"Unknown dispatch mode: {mode}")

        return ResultEmitterFactory.create(
            emitter_type=emitter_type,
            task_id=task_id,
            subtask_id=subtask_id,
            **kwargs,
        )
