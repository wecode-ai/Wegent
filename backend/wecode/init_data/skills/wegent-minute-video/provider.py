# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Shell provider for the one-minute creative-video Skill."""

from __future__ import annotations

import importlib
import sys
from typing import Any

from langchain_core.tools import BaseTool

from chat_shell.skills import SkillToolContext, SkillToolProvider


class MinuteVideoProvider(SkillToolProvider):
    """Create QIA workflow tools with request-scoped generation settings."""

    @property
    def provider_name(self) -> str:
        return "wegent-minute-video"

    @property
    def supported_tools(self) -> list[str]:
        return [
            "analyze_video_material",
            "save_draft_script",
            "create_script_by_draft",
            "generate_storyboard_videos",
            "generate_final_video",
        ]

    def create_tool(
        self,
        tool_name: str,
        context: SkillToolContext,
        tool_config: dict[str, Any] | None = None,
    ) -> BaseTool:
        del tool_config
        tools = self._get_tools_module()
        config = (
            context.skill_config.get("config", {})
            if isinstance(context.skill_config, dict)
            else {}
        )
        common = {
            "task_id": context.task_id,
            "subtask_id": context.subtask_id,
            "user_id": context.user_id,
            "user_name": context.user_name,
            "ws_emitter": context.ws_emitter,
        }
        if tool_name == "analyze_video_material":
            return tools.AnalyzeVideoMaterialTool(
                **common,
                generation=config.get("generation"),
            )
        if tool_name == "save_draft_script":
            return tools.SaveDraftScriptTool(
                **common,
                generation=config.get("generation"),
                history_generation=config.get("history_generation"),
                prompt=config.get("prompt"),
                material_errors=config.get("material_errors"),
            )
        tool_classes = {
            "create_script_by_draft": tools.CreateScriptByDraftTool,
            "generate_storyboard_videos": tools.GenerateStoryboardVideosTool,
            "generate_final_video": tools.GenerateFinalVideoTool,
        }
        tool_class = tool_classes.get(tool_name)
        if tool_class is None:
            raise ValueError(f"Unsupported one-minute-video tool: {tool_name}")
        return tool_class(**common)

    @staticmethod
    def _get_tools_module():
        package = __name__.rsplit(".", 1)[0]
        module_name = f"{package}.tools"
        module = sys.modules.get(module_name)
        if module is None:
            module = importlib.import_module(module_name)
        return module
