# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Channel Command Parser.

This module parses slash commands from IM channel messages.
These commands are channel-agnostic and work across all IM integrations.

Supported commands:
- /devices - List online devices
- /devices <index|name> - Switch to specified device (auto enters device mode)
- /models - List available models
- /models <index|name> - Switch to specified model
- /use - Show current execution mode
- /use chat - Switch to chat mode
- /use cloud - Switch to cloud mode
- /status - Show current status
- /new - Start new conversation
- /help - Show available commands
"""

import logging
from dataclasses import dataclass
from enum import Enum
from typing import Optional

logger = logging.getLogger(__name__)


class CommandType(str, Enum):
    """Channel command types."""

    DEVICES = "devices"  # List devices
    USE = "use"  # Switch device
    MODELS = "models"  # List/switch models
    STATUS = "status"  # Show status
    NEW = "new"  # New conversation
    HELP = "help"  # Show help
    AGENTS = "agents"  # List/switch teams/agents


@dataclass
class ParsedCommand:
    """Parsed command result."""

    command: CommandType
    argument: Optional[str] = None

    def __str__(self) -> str:
        if self.argument:
            return f"/{self.command.value} {self.argument}"
        return f"/{self.command.value}"


def parse_command(content: str) -> Optional[ParsedCommand]:
    """
    Parse slash command from message content.

    Args:
        content: Message content

    Returns:
        ParsedCommand if content is a valid command, None otherwise
    """
    if not content:
        return None

    # Strip whitespace first, then check for command prefix
    content = content.strip()
    if not content.startswith("/"):
        return None

    parts = content.split(maxsplit=1)
    cmd_str = parts[0].lower()
    argument = parts[1].strip() if len(parts) > 1 else None

    # Map command string to CommandType
    cmd_map = {
        "/devices": CommandType.DEVICES,
        "/device": CommandType.DEVICES,  # Alias for convenience
        "/use": CommandType.USE,
        "/models": CommandType.MODELS,
        "/model": CommandType.MODELS,  # Alias for convenience
        "/status": CommandType.STATUS,
        "/new": CommandType.NEW,
        "/help": CommandType.HELP,
        "/agents": CommandType.AGENTS,  # List/switch teams/agents
    }

    command_type = cmd_map.get(cmd_str)
    if command_type is None:
        return None

    return ParsedCommand(command=command_type, argument=argument)


def is_command(content: str) -> bool:
    """
    Check if content is a valid command.

    Args:
        content: Message content

    Returns:
        True if content is a valid command
    """
    return parse_command(content) is not None


# Help message template
HELP_MESSAGE = """📋 **可用命令**

**智能体管理**
• `/agents` - 查看可用智能体列表
• `/agents <序号|智能体名>` - 切换到指定智能体
• `/agents default` - 恢复使用系统默认智能体

**说明**
• **智能体**: 执行任务的 AI 代理，在 Web 端可创建和配置

**设备管理**
• `/devices` - 查看在线设备列表
• `/devices <序号|设备名>` - 切换到指定设备

**模型管理**
• `/models` - 查看可用模型列表
• `/models <序号|模型名>` - 切换到指定模型

**执行模式**
• `/use` - 查看当前执行模式
• `/use chat` - 切换到对话模式
• `/use cloud` - 切换到云端模式
• `/use device` - 切换到设备模式（使用上次选择的设备）

**会话管理**
• `/new` - 开始新对话
• `/status` - 查看当前状态
• `/help` - 显示此帮助

**执行模式说明**
• **智能体**: 执行任务的 AI 代理，可在 Web 端自定义配置
• **对话模式**: 直接与 AI 对话，使用当前选择的智能体
• **设备模式**: 在本地设备执行代码任务
• **云端模式**: 在云端容器执行代码任务"""


# Status message template
STATUS_TEMPLATE = """📊 **当前状态**

**当前智能体**: {team_name}
**执行模式**: {mode}
{device_info}**当前模型**: {model_name}

💡 使用 `/agents` 切换智能体，`/use` 切换执行模式，`/models` 切换模型，`/devices` 切换设备"""


# Models list message templates
MODELS_HEADER = "🤖 **可用模型列表**\n"
MODELS_EMPTY = "暂无可用模型\n\n💡 请联系管理员配置模型"
MODEL_ITEM_TEMPLATE = "{index}. **{name}** ({provider}){status}\n"
MODELS_FOOTER = "\n💡 使用 `/models <序号>` 或 `/models <模型名>` 切换到指定模型"


# Devices list message templates
DEVICES_HEADER = "📱 **在线设备列表**\n"
DEVICES_EMPTY = "暂无在线设备\n\n💡 在本地运行 Executor 后设备会自动出现"
DEVICE_ITEM_TEMPLATE = "{index}. **{name}** ({device_id}){status}\n"
DEVICES_FOOTER = "\n💡 使用 `/devices <序号>` 或 `/devices <设备名>` 切换到指定设备"

# Agents/Teams list message templates
AGENTS_HEADER = "🤖 **可用智能体列表**\n"
AGENTS_EMPTY = "暂无可用智能体\n\n💡 请在 Web 端创建智能体后使用"
AGENT_ITEM_TEMPLATE = "{index}. **{name}** ({namespace}){status}\n"
AGENTS_FOOTER = "\n💡 使用 `/agents <序号>` 或 `/agents <智能体名>` 切换智能体\n💡 使用 `/agents default` 恢复系统默认"


# IM Channel context hint for AI
# This is appended to user messages to help AI understand the IM channel context
IM_CHANNEL_CONTEXT_HINT = """

---
[系统提示] 当前为 IM 频道对话模式，用户可以使用以下斜杠命令（直接输入命令即可，无需 AI 执行）：
- `/agents` - 查看可用智能体列表
- `/agents <序号|智能体名>` - 切换到指定智能体
- `/agents default` - 恢复使用系统默认智能体
- `/devices` - 查看在线设备列表
- `/devices <序号|设备名>` - 切换到指定设备进入设备模式
- `/models` - 查看可用模型列表
- `/models <序号|模型名>` - 切换到指定模型
- `/use chat` - 切换到对话模式（当前模式）
- `/use device` - 切换到设备模式（在本地设备执行代码任务）
- `/use cloud` - 切换到云端模式（在云端容器执行代码任务）
- `/status` - 查看当前状态
- `/new` - 开始新对话
- `/help` - 显示完整帮助

如果用户询问如何切换智能体、模型、使用设备、执行模式等问题，请引导用户使用上述命令。"""
