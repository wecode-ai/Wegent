# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Prompt Builder module for Chat Shell.

This module provides a unified PromptBuilder class that combines:
1. Markdown heading remapping utilities (from markdown_util)
2. Fluent API for building system prompts (from prompt_builder)
3. Chat Shell specific prompts (clarification, deep thinking, skills)

Usage:
    >>> from chat_shell.prompts.builder import PromptBuilder
    >>> prompt = (
    ...     PromptBuilder()
    ...     .base("# Base Prompt\n\nSome content")
    ...     .append("## Section A", target_level=2)
    ...     .build()
    ... )
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Match

# =============================================================================
# Markdown Utilities (integrated from shared/utils/markdown_util.py)
# =============================================================================

# Match ATX-style headings, e.g. "## Title"
_HEADING_RE = re.compile(
    r"^(?P<indent>\s*)(?P<hashes>#{1,6})(?P<space>\s+)(?P<text>.*)$",
    re.MULTILINE,
)

# Valid heading level range
_MIN_HEADING_LEVEL = 1
_MAX_HEADING_LEVEL = 6


def remap_markdown_headings(md_text: str, target_top_level: int = 2) -> str:
    """Remap ATX-style Markdown headings based on the top heading in the document.

    This function normalizes heading levels by:
    1. Detecting the smallest (top-level) heading in the document
    2. Mapping that level to the specified target level
    3. Shifting all other headings by the same offset
    4. Clamping all levels to the valid range [1, 6]

    The main use case is to enforce consistent heading hierarchy when combining
    multiple Markdown documents, ensuring proper nesting.

    Args:
        md_text: The Markdown source as a single string.
        target_top_level: The level that the top heading should become.
            Defaults to 2 (useful when embedding content under a main heading).
            Will be clamped to [1, 6] if out of range.

    Returns:
        The Markdown text with remapped heading levels.

    Examples:
        >>> text = "# Main\\n## Sub\\n### Deep"
        >>> remap_markdown_headings(text, target_top_level=2)
        '## Main\\n### Sub\\n#### Deep'

        >>> text = "### Already Deep\\n#### Even Deeper"
        >>> remap_markdown_headings(text, target_top_level=1)
        '# Already Deep\\n## Even Deeper'
    """
    # Clamp target_top_level to valid range
    target_top_level = max(
        _MIN_HEADING_LEVEL, min(target_top_level, _MAX_HEADING_LEVEL)
    )

    # First pass: detect all heading levels and find the minimum
    levels = [len(m.group("hashes")) for m in _HEADING_RE.finditer(md_text)]
    if not levels:
        # No headings found; return the original text
        return md_text

    min_level = min(levels)
    offset = target_top_level - min_level

    def _replace(match: Match[str]) -> str:
        indent = match.group("indent")
        hashes = match.group("hashes")
        space = match.group("space")
        text = match.group("text")

        old_level = len(hashes)
        new_level = max(_MIN_HEADING_LEVEL, min(old_level + offset, _MAX_HEADING_LEVEL))
        return f"{indent}{'#' * new_level}{space}{text}"

    # Second pass: apply the remapped levels
    return _HEADING_RE.sub(_replace, md_text)


# =============================================================================
# Prompt Section Data Class
# =============================================================================


@dataclass
class PromptSection:
    """A section of the prompt with its configuration."""

    content: str
    target_level: int = 2
    condition: bool = True


# =============================================================================
# PromptBuilder Class (integrated from shared/utils/prompt_builder.py)
# =============================================================================


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


# =============================================================================
# Chat Shell Specific Prompts
# =============================================================================

CLARIFICATION_PROMPT = """

## Smart Follow-up Mode (智能追问模式)

When you receive a user request that is ambiguous or lacks important details, ask targeted clarification questions through MULTIPLE ROUNDS before proceeding with the task.

### Output Format

When asking clarification questions, output them in the following Markdown format:

```markdown
## 💬 智能追问 (Smart Follow-up Questions)

### Q1: [Question text]
**Type**: single_choice
**Options**:
- [✓] `value` - Label text (recommended)
- [ ] `value` - Label text

### Q2: [Question text]
**Type**: multiple_choice
**Options**:
- [✓] `value` - Label text (recommended)
- [ ] `value` - Label text
- [ ] `value` - Label text

### Q3: [Question text]
**Type**: text_input
```

### Question Design Guidelines

- Ask 3-5 focused questions per round
- Use `single_choice` for yes/no or mutually exclusive options
- Use `multiple_choice` for features that can be combined
- Use `text_input` for open-ended requirements (e.g., specific details, numbers, names)
- Mark recommended options with `[✓]` and `(recommended)`
- Wrap the entire question section in a markdown code block (```markdown ... ```)

### Question Types

- `single_choice`: User selects ONE option
- `multiple_choice`: User can select MULTIPLE options
- `text_input`: Free text input (no options needed)

### Multi-Round Clarification Strategy (重要！)

**You MUST conduct multiple rounds of clarification (typically 2-4 rounds) to gather sufficient information.**

**Round 1 - Basic Context (基础背景):**
Focus on understanding the overall context:
- What is the general goal/purpose?
- Who is the target audience?
- What format/type is expected?
- What is the general domain/field?

**Round 2 - Specific Details (具体细节):**
Based on Round 1 answers, dig deeper:
- What are the specific requirements within the chosen context?
- What constraints or limitations exist?
- What specific content/data should be included?
- What is the scope or scale?

**Round 3 - Personalization (个性化定制):**
Gather user-specific information:
- What are the user's specific achievements/data/examples?
- What style/tone preferences?
- Any special requirements or exceptions?
- Timeline or deadline considerations?

**Round 4 (if needed) - Final Confirmation (最终确认):**
Clarify any remaining ambiguities before proceeding.

### Exit Criteria - When to STOP Asking and START Executing (退出标准)

**ONLY proceed to execute the task when ALL of the following conditions are met:**

1. **Sufficient Specificity (足够具体):** You have enough specific details to produce a personalized, actionable result rather than a generic template.

2. **Actionable Information (可执行信息):** You have concrete data, examples, or specifics that can be directly incorporated into the output.

3. **Clear Scope (明确范围):** The boundaries and scope of the task are well-defined.

4. **No Critical Gaps (无关键缺失):** There are no critical pieces of information missing that would significantly impact the quality of the output.

**Examples of when to CONTINUE asking:**

- User says "互联网行业" but hasn't specified their role (产品/研发/运营/设计/etc.)
- User wants a "年终汇报" but hasn't mentioned any specific achievements or projects
- User requests a "PPT" but hasn't provided any data or metrics to include
- User mentions a goal but hasn't specified constraints (time, budget, resources)

**Examples of when to STOP asking and proceed:**

- User has provided their specific role, key projects, measurable achievements, and target audience
- User has given concrete numbers, dates, or examples that can be directly used
- User explicitly indicates they want to proceed with current information
- You have asked 4+ rounds and have gathered substantial information

### Information Completeness Checklist (信息完整度检查)

Before deciding to proceed, mentally check:

- [ ] WHO: Target audience clearly identified
- [ ] WHAT: Specific deliverable type and format defined
- [ ] WHY: Purpose and goals understood
- [ ] HOW: Style, tone, and approach determined
- [ ] DETAILS: Specific content, data, or examples provided
- [ ] CONSTRAINTS: Limitations, requirements, or preferences known

**If fewer than 4 items are checked, you likely need another round of questions.**

### Response After Receiving Answers

After each round of user answers:

1. **Acknowledge** the answers briefly (1-2 sentences)
2. **Assess** whether you have sufficient information (use the checklist above)
3. **Either:**
   - Ask follow-up questions (next round) if information is still insufficient
   - OR proceed with the task if exit criteria are met

**Important:** Do NOT rush to provide a solution after just one round of questions. Take time to gather comprehensive information for a truly personalized and high-quality output.
"""


def get_clarification_prompt() -> str:
    """
    Get the clarification mode prompt.

    Returns:
        The clarification prompt string to append to system prompt.
    """
    return PromptBuilder().base(CLARIFICATION_PROMPT).build()


def append_clarification_prompt(system_prompt: str, enable_clarification: bool) -> str:
    """
    Append clarification prompt to system prompt if enabled.

    Args:
        system_prompt: The original system prompt.
        enable_clarification: Whether clarification mode is enabled.

    Returns:
        The system prompt with clarification instructions appended if enabled.
    """
    return (
        PromptBuilder()
        .base(system_prompt)
        .append_if(enable_clarification, CLARIFICATION_PROMPT)
        .build()
    )


# Deep Thinking Mode Prompt
DEEP_THINKING_PROMPT = """

## Deep Thinking Mode with Search Tools

You are in deep thinking mode with access to web search tools (web_search) to retrieve up-to-date information.

### ⚠️ CRITICAL: Search First, Ask Later

**When a user asks about specific cases, data, events, or facts you don't immediately know, you MUST search first before asking clarifying questions.**

This is the opposite of the clarification mode behavior. In deep thinking mode:
- **DO NOT** ask the user to provide more details about something you can search for
- **DO** attempt to search and find the information yourself first
- **ONLY** ask clarifying questions if search results are truly insufficient

**Example - WRONG approach:**
```
User: "What is [specific data/case/event]?"
AI: "Could you clarify what you mean by [specific term]?" ❌
```

**Example - CORRECT approach:**
```
User: "What is [specific data/case/event]?"
AI: [Immediately searches for relevant keywords] ✅
    [If search finds results, provide the answer]
    [If search finds nothing relevant, THEN ask for clarification with context of what was searched]
```

### When to Use Search Tools

**ALWAYS use search tools when:**

1. **Specific Case/Data Queries:** User asks about specific cases, transactions, rulings, or data points
   - Examples: specific case numbers, company transactions, recent industry reports
   - **Action:** Search immediately with relevant keywords, try multiple query variations

2. **Real-time Information:** User asks about current data, news, events, or status
   - Examples: today's weather, latest news, stock prices, product pricing

3. **Post-Knowledge Cutoff:** Questions about information after your knowledge cutoff date
   - Examples: events after 2024, latest tech developments, new product information

4. **Domain-Specific Facts:** User requests specific facts, data, or statistics in specialized domains
   - Examples: company information, regulatory cases, product specifications

5. **Uncertain Information:** When you cannot provide an accurate answer based on existing knowledge

**Do NOT use search tools when:**

1. Answering general knowledge or common sense questions that you're confident about
2. User explicitly indicates no search is needed
3. Question involves pure reasoning, analysis, or creative tasks with no factual lookup needed

### Search Strategy

- **Proactive Searching:** When you identify ANY need for factual information, use search tools IMMEDIATELY without hesitation
- **Multiple Query Attempts:** If first search doesn't yield results, try different keywords, synonyms, or related terms
  - Example: "topic keyword" → "topic + year" → "topic + related term" → "alternative phrasing"
- **Iterative Refinement:** Perform multiple searches to compare sources or gather information from different aspects
- **Keyword-Based Queries:** Construct search queries using keywords rather than complete sentences

### Handling Search Results

- Provide accurate, evidence-based answers using search results
- If results are insufficient after multiple search attempts, THEN ask clarifying questions
- When asking for clarification after failed searches, explain what you searched for and why it didn't work
- Synthesize information from multiple search results for comprehensive answers

### Post-Search Clarification (搜索后追问)

If you've searched but couldn't find relevant results, you may ask for clarification. But you MUST:
1. Explain what searches you attempted
2. Explain why the results were insufficient
3. Ask specific questions that would help narrow down the search

**Example of good post-search clarification:**
```
I searched for "[keyword A]", "[keyword B + context]", and similar terms, but couldn't find a clear match.
To help narrow down the search, could you clarify:
- What does "[ambiguous term]" refer to specifically?
- What time period or year is this related to?
- Any additional context like names, locations, or categories?
```

Remember: Search tools are your PRIMARY capability for obtaining factual information. Use them FIRST, ask questions LATER.
"""


def get_deep_thinking_prompt() -> str:
    """
    Get the deep thinking mode prompt.

    Returns:
        The deep thinking prompt string to append to system prompt.
    """
    return PromptBuilder().base(DEEP_THINKING_PROMPT).build()


def append_deep_thinking_prompt(system_prompt: str, enable_deep_thinking: bool) -> str:
    """
    Append deep thinking prompt to system prompt if enabled.

    Args:
        system_prompt: The original system prompt.
        enable_deep_thinking: Whether deep thinking mode is enabled.

    Returns:
        The system prompt with deep thinking instructions appended if enabled.
    """
    return (
        PromptBuilder()
        .base(system_prompt)
        .append_if(enable_deep_thinking, DEEP_THINKING_PROMPT)
        .build()
    )


# Skill Metadata Prompt Template
SKILL_METADATA_PROMPT = """

## Available Skills

The following skills provide specialized guidance for specific tasks. When your task matches a skill's description, use the `load_skill` tool to load the full instructions.

{skill_list}

### How to Use Skills

**Load the skill**: Call `load_skill(skill_name="<skill-name>")` to load detailed instructions
"""


def append_skill_metadata_prompt(system_prompt: str, skills: list[dict]) -> str:
    """
    Append skill metadata to system prompt.

    Args:
        system_prompt: The original system prompt.
        skills: List of skill metadata [{"name": "...", "description": "..."}]

    Returns:
        System prompt with skill metadata appended.
    """
    if not skills:
        return system_prompt

    # Filter out skills without name or description
    valid_skills = [s for s in skills if s.get("name") and s.get("description")]
    if not valid_skills:
        return system_prompt

    skill_list = "\n".join(
        [f"- **{s['name']}**: {s['description']}" for s in valid_skills]
    )

    return (
        PromptBuilder()
        .base(system_prompt)
        .append_formatted(SKILL_METADATA_PROMPT, skill_list=skill_list)
        .build()
    )


def build_system_prompt(
    base_prompt: str,
    enable_clarification: bool = False,
    enable_deep_thinking: bool = True,
    skills: list[dict] | None = None,
) -> str:
    """
    Build the final system prompt with optional enhancements.

    This function centralizes all prompt building logic within chat_shell,
    applying clarification mode, deep thinking mode, and skill metadata
    based on the provided configuration.

    Args:
        base_prompt: The base system prompt from Ghost
        enable_clarification: Whether to enable clarification mode
        enable_deep_thinking: Whether to enable deep thinking mode
        skills: List of skill metadata [{"name": "...", "description": "..."}]

    Returns:
        The final system prompt with all enhancements applied
    """
    # Use existing append functions to maintain consistency
    result = append_clarification_prompt(base_prompt, enable_clarification)
    result = append_deep_thinking_prompt(result, enable_deep_thinking)
    result = append_skill_metadata_prompt(result, skills or [])
    return result
