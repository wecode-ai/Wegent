# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified block data structures for mixed content rendering.

This module defines the data structures for blocks used in:
1. WebSocket events (chat:block_created, chat:block_updated)
2. Database storage (subtask.result.blocks)
3. Frontend rendering (MixedContentView)

Block Types:
- ToolBlock: Represents a tool call (e.g., Bash, Read, Write)
- TextBlock: Represents text content between tool calls
- GuidanceBlock: Represents user guidance applied to a Chat Shell turn

The blocks maintain the order of tool-text-tool-text for proper
mixed content rendering.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Literal, Optional, Union


class BlockType(str, Enum):
    """Block type enumeration."""

    TOOL = "tool"
    TEXT = "text"
    GUIDANCE = "guidance"


class BlockStatus(str, Enum):
    """Block status enumeration."""

    PENDING = "pending"  # Tool is executing
    STREAMING = "streaming"  # Text is being streamed
    DONE = "done"  # Block is complete
    ERROR = "error"  # Tool execution failed


@dataclass
class ToolBlock:
    """Tool block representing a tool call.

    Attributes:
        id: Unique block identifier (usually tool_use_id)
        type: Always "tool"
        tool_use_id: Tool use ID from the LLM
        tool_name: Name of the tool (e.g., "Bash", "Read", "Write")
        tool_input: Input parameters for the tool
        tool_protocol: Optional Responses API protocol type
        server_label: Optional MCP server label
        status: Current status (pending, done, error)
        timestamp: Unix timestamp in milliseconds
        display_name: Optional human-readable display name
        tool_output: Optional output from tool execution
    """

    id: str
    tool_use_id: str
    tool_name: str
    tool_input: Dict[str, Any] = field(default_factory=dict)
    tool_protocol: Optional[str] = None
    server_label: Optional[str] = None
    status: str = BlockStatus.PENDING.value
    timestamp: int = 0
    display_name: Optional[str] = None
    tool_output: Optional[str] = None
    type: Literal["tool"] = "tool"

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result = {
            "id": self.id,
            "type": self.type,
            "tool_use_id": self.tool_use_id,
            "tool_name": self.tool_name,
            "tool_input": self.tool_input,
            "status": self.status,
            "timestamp": self.timestamp,
        }
        if self.tool_protocol:
            result["tool_protocol"] = self.tool_protocol
        if self.server_label:
            result["server_label"] = self.server_label
        if self.display_name:
            result["display_name"] = self.display_name
        if self.tool_output:
            result["tool_output"] = self.tool_output
        return result

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ToolBlock":
        """Create from dictionary."""
        return cls(
            id=data.get("id", ""),
            tool_use_id=data.get("tool_use_id", ""),
            tool_name=data.get("tool_name", ""),
            tool_input=data.get("tool_input", {}),
            tool_protocol=data.get("tool_protocol"),
            server_label=data.get("server_label"),
            status=data.get("status", BlockStatus.PENDING.value),
            timestamp=data.get("timestamp", 0),
            display_name=data.get("display_name"),
            tool_output=data.get("tool_output"),
        )


@dataclass
class TextBlock:
    """Text block representing text content.

    Attributes:
        id: Unique block identifier
        type: Always "text"
        content: Text content
        status: Current status (streaming, done)
        timestamp: Unix timestamp in milliseconds
    """

    id: str
    content: str = ""
    status: str = BlockStatus.STREAMING.value
    timestamp: int = 0
    type: Literal["text"] = "text"

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "id": self.id,
            "type": self.type,
            "content": self.content,
            "status": self.status,
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TextBlock":
        """Create from dictionary."""
        return cls(
            id=data.get("id", ""),
            content=data.get("content", ""),
            status=data.get("status", BlockStatus.STREAMING.value),
            timestamp=data.get("timestamp", 0),
        )


@dataclass
class GuidanceBlock:
    """Guidance block representing user guidance applied to a Chat Shell turn."""

    id: str
    guidance_id: str
    content: str
    status: str = BlockStatus.DONE.value
    timestamp: int = 0
    loop_index: Optional[int] = None
    applied_at: Optional[str] = None
    type: Literal["guidance"] = "guidance"

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        result = {
            "id": self.id,
            "type": self.type,
            "guidance_id": self.guidance_id,
            "content": self.content,
            "status": self.status,
            "timestamp": self.timestamp,
        }
        if self.loop_index is not None:
            result["loop_index"] = self.loop_index
        if self.applied_at is not None:
            result["applied_at"] = self.applied_at
        return result

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "GuidanceBlock":
        """Create from dictionary."""
        return cls(
            id=data.get("id", ""),
            guidance_id=data.get("guidance_id", ""),
            content=data.get("content", ""),
            status=data.get("status", BlockStatus.DONE.value),
            timestamp=data.get("timestamp", 0),
            loop_index=data.get("loop_index"),
            applied_at=data.get("applied_at"),
        )


# Type alias for any block type
MessageBlock = Union[ToolBlock, TextBlock, GuidanceBlock]


def block_from_dict(data: Dict[str, Any]) -> MessageBlock:
    """Create a block from dictionary based on type field.

    Args:
        data: Dictionary with block data

    Returns:
        ToolBlock or TextBlock instance
    """
    block_type = data.get("type", "")
    if block_type == BlockType.TOOL.value:
        return ToolBlock.from_dict(data)
    elif block_type == BlockType.TEXT.value:
        return TextBlock.from_dict(data)
    elif block_type == BlockType.GUIDANCE.value:
        return GuidanceBlock.from_dict(data)
    else:
        # Default to text block for unknown types
        return TextBlock.from_dict(data)


def blocks_from_list(data: List[Dict[str, Any]]) -> List[MessageBlock]:
    """Create a list of blocks from list of dictionaries.

    Args:
        data: List of block dictionaries

    Returns:
        List of ToolBlock or TextBlock instances
    """
    return [block_from_dict(item) for item in data]


def blocks_to_list(blocks: List[MessageBlock]) -> List[Dict[str, Any]]:
    """Convert a list of blocks to list of dictionaries.

    Args:
        blocks: List of ToolBlock or TextBlock instances

    Returns:
        List of block dictionaries
    """
    return [block.to_dict() for block in blocks]


def create_tool_block(
    tool_use_id: str,
    tool_name: str,
    tool_input: Optional[Dict[str, Any]] = None,
    display_name: Optional[str] = None,
    tool_protocol: Optional[str] = None,
    server_label: Optional[str] = None,
    timestamp: Optional[int] = None,
) -> Dict[str, Any]:
    """Create a tool block dictionary.

    This is a convenience function for creating tool blocks without
    instantiating the dataclass.

    Args:
        tool_use_id: Tool use ID
        tool_name: Tool name
        tool_input: Tool input parameters
        display_name: Optional display name
        tool_protocol: Optional protocol type
        server_label: Optional MCP server label
        timestamp: Optional timestamp (defaults to current time)

    Returns:
        Tool block dictionary
    """
    import time

    ts = timestamp if timestamp is not None else int(time.time() * 1000)
    block_id = tool_use_id or f"tool-{ts}"

    result = {
        "id": block_id,
        "type": BlockType.TOOL.value,
        "tool_use_id": tool_use_id,
        "tool_name": tool_name,
        "tool_input": tool_input or {},
        "status": BlockStatus.PENDING.value,
        "timestamp": ts,
    }
    if display_name:
        result["display_name"] = display_name
    if tool_protocol:
        result["tool_protocol"] = tool_protocol
    if server_label:
        result["server_label"] = server_label
    return result


def create_text_block(
    content: str = "",
    block_id: Optional[str] = None,
    timestamp: Optional[int] = None,
) -> Dict[str, Any]:
    """Create a text block dictionary.

    This is a convenience function for creating text blocks without
    instantiating the dataclass.

    Args:
        content: Text content
        block_id: Optional block ID (defaults to generated ID)
        timestamp: Optional timestamp (defaults to current time)

    Returns:
        Text block dictionary
    """
    import time

    ts = timestamp if timestamp is not None else int(time.time() * 1000)
    bid = block_id or f"text-{ts}"

    return {
        "id": bid,
        "type": BlockType.TEXT.value,
        "content": content,
        "status": BlockStatus.STREAMING.value,
        "timestamp": ts,
    }


def create_guidance_block(
    guidance_id: str,
    content: str,
    block_id: Optional[str] = None,
    timestamp: Optional[int] = None,
    loop_index: Optional[int] = None,
    applied_at: Optional[str] = None,
) -> Dict[str, Any]:
    """Create a guidance block dictionary."""
    import time

    ts = timestamp if timestamp is not None else int(time.time() * 1000)
    bid = block_id or f"guidance-{guidance_id}"
    block = GuidanceBlock(
        id=bid,
        guidance_id=guidance_id,
        content=content,
        timestamp=ts,
        loop_index=loop_index,
        applied_at=applied_at,
    )
    return block.to_dict()
