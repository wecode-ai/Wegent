# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Feature flags configuration for chat services.

This module provides a unified Features dataclass to manage all feature toggles
across the chat service stack, avoiding scattered enable_* fields.
"""

from dataclasses import dataclass, field


@dataclass
class Features:
    """Unified feature flags for chat services.

    This class centralizes all feature toggles (enable_*) to ensure:
    1. Consistent configuration across all layers
    2. Easy addition of new features
    3. Type-safe feature management
    4. Single source of truth

    Attributes:
        enable_tools: Enable tool usage (MCP, web search, skills, etc.)
        enable_web_search: Enable web search tool
        enable_clarification: Enable smart follow-up questions mode
        enable_deep_thinking: Enable deep thinking mode with search
        enable_canvas: Enable Canvas artifact mode for content creation
        search_engine: Specific search engine to use (if web_search enabled)
    """

    enable_tools: bool = True
    enable_web_search: bool = False
    enable_clarification: bool = False
    enable_deep_thinking: bool = True
    enable_canvas: bool = True
    search_engine: str | None = None

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization.

        Returns:
            Dictionary representation of feature flags
        """
        return {
            "enable_tools": self.enable_tools,
            "enable_web_search": self.enable_web_search,
            "enable_clarification": self.enable_clarification,
            "enable_deep_thinking": self.enable_deep_thinking,
            "enable_canvas": self.enable_canvas,
            "search_engine": self.search_engine,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Features":
        """Create Features from dictionary.

        Args:
            data: Dictionary with feature flag values

        Returns:
            Features instance with values from dict
        """
        return cls(
            enable_tools=data.get("enable_tools", True),
            enable_web_search=data.get("enable_web_search", False),
            enable_clarification=data.get("enable_clarification", False),
            enable_deep_thinking=data.get("enable_deep_thinking", True),
            enable_canvas=data.get("enable_canvas", True),
            search_engine=data.get("search_engine"),
        )

    @classmethod
    def from_payload(cls, payload: any) -> "Features":
        """Create Features from WebSocket payload.

        Args:
            payload: WebSocket payload object with feature flags

        Returns:
            Features instance extracted from payload
        """
        return cls(
            enable_tools=True,  # Always enabled for direct chat
            enable_web_search=getattr(payload, "enable_web_search", False),
            enable_clarification=getattr(payload, "enable_clarification", False),
            enable_deep_thinking=getattr(payload, "enable_deep_thinking", True),
            enable_canvas=True,  # Always enabled for Canvas support
            search_engine=getattr(payload, "search_engine", None),
        )
