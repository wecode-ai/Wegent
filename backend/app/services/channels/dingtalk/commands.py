# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
DingTalk Command Parser.

This module parses slash commands from DingTalk messages:
- /devices - List online devices
- /use <device_name|cloud> - Switch execution device
- /use - Switch back to chat mode
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
    """DingTalk command types."""

    DEVICES = "devices"  # List devices
    USE = "use"  # Switch device
    STATUS = "status"  # Show status
    NEW = "new"  # New conversation
    HELP = "help"  # Show help


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
        "/use": CommandType.USE,
        "/status": CommandType.STATUS,
        "/new": CommandType.NEW,
        "/help": CommandType.HELP,
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

**设备管理**
• `/devices` - 查看在线设备列表
• `/use <设备名>` - 切换到指定设备执行
• `/use cloud` - 切换到云端执行
• `/use` - 切换回对话模式

**会话管理**
• `/new` - 开始新对话
• `/status` - 查看当前状态
• `/help` - 显示此帮助

**执行模式说明**
• **对话模式**: 直接与 AI 对话，快速响应
• **设备模式**: 在本地设备执行代码任务
• **云端模式**: 在云端容器执行代码任务"""


# Status message template
STATUS_TEMPLATE = """📊 **当前状态**

**执行模式**: {mode}
{device_info}
**默认智能体**: {team_name}

💡 使用 `/use` 命令切换执行模式"""


# Devices list message templates
DEVICES_HEADER = "📱 **在线设备列表**\n"
DEVICES_EMPTY = "暂无在线设备\n\n💡 在本地运行 Executor 后设备会自动出现"
DEVICE_ITEM_TEMPLATE = "• **{name}** ({device_id}){status}\n"
DEVICES_FOOTER = "\n💡 使用 `/use <设备名>` 切换到指定设备"
