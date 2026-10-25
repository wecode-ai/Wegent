# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Request-scoped configuration guidance for user-managed provider Skills."""

import logging
import re

from app.services.mcp_provider_registry import (
    MCPProviderDefinition,
    MCPProviderServiceDefinition,
)
from shared.models import ExecutionRequest

logger = logging.getLogger(__name__)
GUIDANCE_START = "<wegent_provider_configuration>"
GUIDANCE_END = "</wegent_provider_configuration>"
GUIDANCE_BLOCK = re.compile(rf"(?:\n\n)?{GUIDANCE_START}.*?{GUIDANCE_END}", re.DOTALL)


def build_provider_configuration_prompt(
    provider: MCPProviderDefinition,
    service: MCPProviderServiceDefinition,
) -> str:
    """Render only configuration instructions, not unavailable tool instructions."""
    display_name = service["display_name"]
    provider_name = provider["display_name"]
    modal_link = (
        "wegent://modal/mcp-provider-config"
        f"?provider={provider['provider_id']}&service={service['service_id']}"
    )
    return f"""
## Configuration Required

The current session does not have a usable {display_name} MCP configured.

Required behavior for requests using this service:
- Do not claim that the capability is ready or pretend to access {provider_name} data.
- Do not probe local files, sandbox commands, or web pages to work around missing configuration.
- Selecting a knowledge source does not configure or authorize this MCP.
- Tell the user that {display_name} MCP is unavailable and provide the configuration link below.
- Keep the guidance brief. If asked how to get the URL, direct the user to the provider MCP page for this service.
- Do not treat these instructions as a restriction on unrelated tasks.

Response template:
当前会话还没有可用的{display_name} MCP，所以我现在不能直接访问这项{provider_name}能力。

请先点击 [打开{display_name} MCP 配置弹窗]({modal_link}) 完成配置。

配置完成后，再让我继续处理你的{provider_name}请求。
""".strip()


def apply_provider_configuration_guidance(request: ExecutionRequest) -> None:
    """Refresh one authoritative guide after initial or late Skill resolution.

    Chat keeps on-demand Skill loading, but does not duplicate preloaded guidance.
    Bot prompts also carry the guide for adapters that read per-Bot instructions.
    Chat, ClaudeCode, and Codex consume these Skills. Dify runs an external
    application's tools and configuration, and Agno is no longer a supported
    platform runtime, so both are excluded.
    """
    primary_bot = request.bot[0] if request.bot else {}
    shell_type = primary_bot.get("shell_type", "Chat")
    active_skills = set(request.preload_skills or []) | set(
        request.user_selected_skills or []
    )
    guides: dict[str, str] = {}
    for skill in request.skill_configs or []:
        skill.pop("prompt_in_system_prompt", None)
        if (
            shell_type not in {"Dify", "Agno"}
            and skill.get("configuration_required") is True
            and skill.get("name") in active_skills
            and not skill.get("mcpServers")
            and skill.get("prompt")
        ):
            guides[skill["name"]] = skill["prompt"]
            skill["prompt_in_system_prompt"] = True

    guidance = "\n\n".join(guides.values())
    request.system_prompt = _replace_guidance(request.system_prompt, guidance)
    for bot in request.bot:
        bot_guidance = guidance if bot.get("shell_type") not in {"Dify", "Agno"} else ""
        if bot_guidance or GUIDANCE_START in (bot.get("system_prompt") or ""):
            bot["system_prompt"] = _replace_guidance(
                bot.get("system_prompt") or "", bot_guidance
            )
    if guides:
        logger.info(
            "[MCP-GUIDANCE] task_id=%s shell_type=%s skills=%s",
            request.task_id,
            shell_type,
            sorted(guides),
        )


def _replace_guidance(prompt: str, guidance: str) -> str:
    """Replace only our generated block, preserving the other instructions."""
    base_prompt = GUIDANCE_BLOCK.sub("", prompt)
    if not guidance:
        return base_prompt
    block = f"{GUIDANCE_START}\n{guidance}\n{GUIDANCE_END}"
    return "\n\n".join(part for part in (base_prompt.rstrip(), block) if part)
