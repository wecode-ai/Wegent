# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Clarification Mode Prompt.

This module contains the system prompt for smart follow-up questions mode.
When enabled, the AI will ask targeted clarification questions before proceeding.

Also contains the Deep Thinking Mode prompt for search tool usage guidance.
"""

CLARIFICATION_PROMPT = """

<clarification_mode>
## Smart Follow-up Mode (智能追问模式)

When you receive a user request that is ambiguous or lacks important details, use the `interactive_form_question` tool to ask targeted clarification questions through MULTIPLE ROUNDS before proceeding with the task.

### ⚠️ CRITICAL: You MUST Use the interactive_form_question Tool

**ALWAYS call the `interactive_form_question` tool to ask clarification questions. NEVER output questions as plain text or Markdown.**

❌ **DO NOT** output questions as Markdown lists or numbered lists
❌ **DO NOT** write "1. Question A  2. Question B" in plain text
❌ **DO NOT** output the old `## 💬 智能追问` Markdown format
✅ **ALWAYS** call `interactive_form_question(questions=[...])` to display an interactive form

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

**Examples of when to CONTINUE asking (call interactive_form_question again):**

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

**If fewer than 4 items are checked, you likely need another round of questions (call interactive_form_question again).**

### Question Design Guidelines

- Ask **3-5 focused questions** per round
- Prefer multi-question mode (`questions` array) to ask all questions at once — avoids multiple round-trips
- Use `single_choice` (`multi_select: false`) for yes/no or mutually exclusive options
- Use `multiple_choice` (`multi_select: true`) for features that can be combined
- Use `text_input` (`input_type: "text"`) for open-ended requirements
- Mark recommended options with `recommended: true`
- **Always add a final open-ended text question** at the end of each round for additional thoughts:
  ```
  {
    "id": "additional_input",
    "question": "其他想法或补充说明",
    "input_type": "text",
    "required": false,
    "placeholder": "在此输入其他想法、补充需求或特殊说明..."
  }
  ```

> For detailed `interactive_form_question` tool parameters and examples, refer to the interactive-form-question skill instructions loaded in your context.

### Response After Receiving Answers

After each round of user answers:

1. **Assess** whether you have sufficient information (use the checklist above)
2. **Either:**
   - Call `interactive_form_question` again with follow-up questions if information is still insufficient
   - OR proceed with the task if exit criteria are met

**Important:** Do NOT rush to provide a solution after just one round of questions. Take time to gather comprehensive information for a truly personalized and high-quality output.
</clarification_mode>
"""


def get_clarification_prompt() -> str:
    """
    Get the clarification mode prompt.

    Returns:
        The clarification prompt string to append to system prompt.
    """
    return CLARIFICATION_PROMPT


def append_clarification_prompt(system_prompt: str, enable_clarification: bool) -> str:
    """
    Append clarification prompt to system prompt if enabled.

    The CLARIFICATION_PROMPT now instructs the AI to use the interactive_form_question MCP tool
    (provided by the interactive-form-question skill, auto-injected by TaskRequestBuilder) instead
    of outputting the old Markdown format. This gives the AI clear guidance on
    multi-round clarification strategy while using the interactive form UI.

    Args:
        system_prompt: The original system prompt.
        enable_clarification: Whether clarification mode is enabled.

    Returns:
        The system prompt with clarification instructions appended if enabled.
    """
    if enable_clarification:
        return system_prompt + CLARIFICATION_PROMPT
    return system_prompt


# Deep Thinking Mode Prompt
DEEP_THINKING_PROMPT = ""


def get_deep_thinking_prompt() -> str:
    """
    Get the deep thinking mode prompt.

    Returns:
        The deep thinking prompt string to append to system prompt.
    """
    return DEEP_THINKING_PROMPT


def append_deep_thinking_prompt(system_prompt: str, enable_deep_thinking: bool) -> str:
    """
    Append deep thinking prompt to system prompt if enabled.

    Args:
        system_prompt: The original system prompt.
        enable_deep_thinking: Whether deep thinking mode is enabled.

    Returns:
        The system prompt with deep thinking instructions appended if enabled.
    """
    if enable_deep_thinking:
        return system_prompt + DEEP_THINKING_PROMPT
    return system_prompt


def build_system_prompt(
    base_prompt: str,
    enable_clarification: bool = False,
    enable_deep_thinking: bool = False,
    skills: list[dict] | None = None,
) -> str:
    """
    Build the final system prompt with optional enhancements.

    This function centralizes all prompt building logic within chat_shell,
    applying clarification mode and deep thinking mode based on the provided
    configuration.

    Note: Skill-related prompts (Available Skills + Loaded Skill Instructions)
    are now handled entirely by LoadSkillTool.get_prompt_modification() via
    the prompt_modifier mechanism. The 'skills' parameter is kept for backward
    compatibility but is no longer used here.

    Note: The CLARIFICATION_PROMPT has been updated to instruct the AI to use
    the interactive_form_question MCP tool (provided by the interactive-form-question skill, auto-injected by
    TaskRequestBuilder._inject_clarification_skill) instead of outputting the
    old Markdown format. This gives the AI clear multi-round clarification
    strategy guidance while using the interactive form UI.

    Args:
        base_prompt: The base system prompt from Ghost
        enable_clarification: Whether to enable clarification mode (injects updated prompt)
        enable_deep_thinking: Whether to enable deep thinking mode
        skills: Deprecated - skill prompts are now injected by LoadSkillTool

    Returns:
        The final system prompt with all enhancements applied

    Injection Order:
        1. Base prompt (caller should wrap Ghost systemPrompt in <base_prompt> tags if needed)
        2. Clarification mode instructions (if enabled) - now guides AI to use interactive_form_question tool
        3. Deep thinking mode instructions (if enabled)
        4. Skill prompts (injected dynamically by LoadSkillTool via prompt_modifier)
    """
    system_prompt = base_prompt

    # Append clarification mode instructions if enabled.
    # The CLARIFICATION_PROMPT now instructs the AI to use the interactive_form_question MCP tool
    # (from the interactive-form-question skill auto-injected by TaskRequestBuilder) instead of
    # outputting the old Markdown format.
    if enable_clarification:
        system_prompt = append_clarification_prompt(system_prompt, True)

    # Append deep thinking mode instructions if enabled
    if enable_deep_thinking:
        system_prompt = append_deep_thinking_prompt(system_prompt, True)

    # Note: Skill prompts are now injected dynamically by LoadSkillTool.get_prompt_modification()
    # via the prompt_modifier mechanism in LangGraphAgentBuilder. This ensures that:
    # 1. Available Skills and Loaded Skill Instructions are in the same <skill> block
    # 2. The skill prompt is always up-to-date with the current loaded skills state

    return system_prompt
