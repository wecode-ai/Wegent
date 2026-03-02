# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Polling dispatcher for long-running async tasks.

Routes to specific polling agents based on model type or protocol:
1. modelType == "video" -> VideoAgent
2. protocol == "gemini-deep-research" -> ResearchAgent
"""

import logging
from typing import Optional

from shared.models import ExecutionRequest

from .agents.base import PollingAgent
from .emitters import ResultEmitter
from .router import ExecutionTarget

logger = logging.getLogger(__name__)


async def dispatch_polling(
    request: ExecutionRequest,
    target: ExecutionTarget,
    emitter: ResultEmitter,
) -> None:
    """
    Dispatch to appropriate polling agent.

    Routing logic:
    1. modelType == "video" -> VideoAgent
    2. protocol == "gemini-deep-research" -> ResearchAgent

    Args:
        request: Execution request
        target: Execution target configuration
        emitter: Result emitter for event emission
    """
    model_config = request.model_config or {}
    model_type = model_config.get("modelType")
    protocol = model_config.get("protocol")

    agent = _get_polling_agent(model_type, protocol)

    logger.info(
        f"[PollingDispatcher] Routing to {agent.name}: "
        f"task_id={request.task_id}, modelType={model_type}, protocol={protocol}"
    )

    await agent.execute(request, emitter)


def _get_polling_agent(
    model_type: Optional[str],
    protocol: Optional[str],
) -> PollingAgent:
    """Get appropriate polling agent based on model type or protocol.

    Args:
        model_type: Model type (e.g., 'video', 'llm')
        protocol: Model protocol (e.g., 'gemini-deep-research')

    Returns:
        PollingAgent instance

    Raises:
        ValueError: If no polling agent is available for the given config
    """
    if model_type == "video":
        from .agents.video.video_agent import VideoAgent

        return VideoAgent()

    if protocol == "gemini-deep-research":
        from .agents.research_agent import ResearchAgent

        return ResearchAgent()

    raise ValueError(
        f"No polling agent available for modelType={model_type}, protocol={protocol}"
    )
