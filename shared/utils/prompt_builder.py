# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Prompt Builder module.

This module provides a fluent API for building system prompts with automatic
markdown heading level management. It eliminates the need for manual
`remap_markdown_headings` calls throughout the codebase.

Usage:
    >>> builder = PromptBuilder()
    >>> prompt = (
    ...     builder
    ...     .base("# Base Prompt\n\nSome content")
    ...     .append("## Section A", target_level=2)
    ...     .append("# Section B", target_level=3)
    ...     .build()
    ... )
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from shared.utils.markdown_util import remap_markdown_headings


@dataclass
class PromptSection:
    """A section of the prompt with its configuration."""

    content: str
    target_level: int = 2
    condition: bool = True


class PromptBuilder:
    """Builder for constructing system prompts with automatic heading management.

    This class provides a fluent API for building prompts, automatically applying
    markdown heading remapping to ensure consistent hierarchy when combining
    multiple markdown sections.

    Attributes:
        _base_content: The base prompt content.
        _sections: List of sections to append to the base.
        _default_target_level: Default heading level for appended sections.

    Example:
        >>> builder = PromptBuilder(default_target_level=2)
        >>> result = (
        ...     builder
        ...     .base("# Main Title\\n## Subtitle")
        ...     .append("# Section A\\nContent A", target_level=2)
        ...     .append_if(True, "# Conditional\\nOnly if True")
        ...     .build()
        ... )
    """

    def __init__(self, default_target_level: int = 2) -> None:
        """Initialize the PromptBuilder.

        Args:
            default_target_level: Default heading level for appended sections.
                Defaults to 2 for embedding under a main heading.
        """
        self._base_content: str = ""
        self._sections: list[PromptSection] = []
        self._default_target_level = default_target_level

    def base(self, content: str, target_level: int | None = None) -> PromptBuilder:
        """Set the base prompt content.

        The base content will be remapped to the specified target level.

        Args:
            content: The base prompt markdown content.
            target_level: Target heading level for the base content.
                If None, uses the default_target_level.

        Returns:
            Self for method chaining.
        """
        level = target_level if target_level is not None else self._default_target_level
        self._base_content = remap_markdown_headings(content, level)
        return self

    def append(self, content: str, target_level: int | None = None) -> PromptBuilder:
        """Append a section to the prompt.

        The section content will be remapped to the specified target level
        before appending.

        Args:
            content: The markdown content to append.
            target_level: Target heading level for this section.
                If None, uses the default_target_level.

        Returns:
            Self for method chaining.
        """
        if not content or not content.strip():
            return self

        level = target_level if target_level is not None else self._default_target_level
        self._sections.append(PromptSection(content=content, target_level=level))
        return self

    def append_if(
        self,
        condition: bool,
        content: str,
        target_level: int | None = None,
    ) -> PromptBuilder:
        """Conditionally append a section to the prompt.

        The section will only be appended if the condition is True.

        Args:
            condition: Whether to append this section.
            content: The markdown content to append.
            target_level: Target heading level for this section.
                If None, uses the default_target_level.

        Returns:
            Self for method chaining.
        """
        if condition:
            return self.append(content, target_level)
        return self

    def append_with_header(
        self,
        header: str,
        content: str,
        content_target_level: int = 4,
    ) -> PromptBuilder:
        """Append content with a custom header prefix.

        This is useful for sections like skills where you want a consistent
        header format (e.g., "### Skill: skill_name").

        Args:
            header: The header line to prepend (e.g., "### Skill: my_skill").
            content: The content to append after the header.
            content_target_level: Target heading level for the content.

        Returns:
            Self for method chaining.
        """
        if not content or not content.strip():
            return self

        remapped_content = remap_markdown_headings(content, content_target_level)
        full_section = f"{header}\n\n{remapped_content}"
        # Append raw section without additional remapping since we formatted it
        self._sections.append(
            PromptSection(content=full_section, target_level=0, condition=True)
        )
        return self

    def append_formatted(
        self,
        template: str,
        target_level: int | None = None,
        **kwargs: str,
    ) -> PromptBuilder:
        """Append a formatted template section.

        Args:
            template: A template string with placeholders (e.g., "{skill_list}").
            target_level: Target heading level for this section.
            **kwargs: Values to format into the template.

        Returns:
            Self for method chaining.
        """
        content = template.format(**kwargs)
        return self.append(content, target_level)

    def build(self) -> str:
        """Build and return the final prompt string.

        All sections are joined with the base content, with each section's
        heading levels properly remapped.

        Returns:
            The complete prompt string.
        """
        parts = [self._base_content] if self._base_content else []

        for section in self._sections:
            if not section.condition or not section.content:
                continue

            # target_level=0 means raw append (already formatted)
            if section.target_level == 0:
                parts.append(section.content)
            else:
                remapped = remap_markdown_headings(
                    section.content, section.target_level
                )
                parts.append(remapped)

        return "".join(parts)

    def reset(self) -> PromptBuilder:
        """Reset the builder to its initial state.

        Returns:
            Self for method chaining.
        """
        self._base_content = ""
        self._sections = []
        return self


def build_prompt(
    base: str,
    *sections: tuple[str, int] | str,
    default_level: int = 2,
) -> str:
    """Convenience function for building prompts in a single call.

    Args:
        base: The base prompt content.
        *sections: Variable sections to append. Each can be:
            - A string (uses default_level)
            - A tuple of (content, target_level)
        default_level: Default heading level for sections.

    Returns:
        The built prompt string.

    Example:
        >>> prompt = build_prompt(
        ...     "# Base",
        ...     "## Section A",
        ...     ("# Deep Section", 4),
        ... )
    """
    builder = PromptBuilder(default_target_level=default_level)
    builder.base(base)

    for section in sections:
        if isinstance(section, tuple):
            content, level = section
            builder.append(content, level)
        else:
            builder.append(section)

    return builder.build()
