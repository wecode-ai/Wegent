# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Wizard API endpoints for agent creation wizard.

This module provides APIs for the step-by-step agent creation wizard,
including AI-powered follow-up questions and prompt generation.
"""

import json
import logging
import re
from typing import Any, List

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import TypeAdapter

from app.core import security
from app.core.payload_codec import run_payload_codec
from app.core.request_body_limit import WIZARD_BODY_MAX_BYTES
from app.core.request_json import validate_json_request
from app.models.user import User
from app.schemas.wizard import (
    AvailableSkill,
    CoreQuestion,
    CoreQuestionsResponse,
    CreateAllRequest,
    CreateAllResponse,
    FollowUpQuestion,
    FollowUpRequest,
    FollowUpResponse,
    GeneratePromptRequest,
    GeneratePromptResponse,
    IteratePromptRequest,
    IteratePromptResponse,
    RecommendConfigRequest,
    RecommendConfigResponse,
    SkillRecommendation,
    TestPromptRequest,
    TestPromptResponse,
)
from app.services.chat.storage.db import run_sync_in_executor
from app.services.execution.web_stream_client import web_stream_worker_client
from app.services.execution.web_stream_protocol import (
    WIZARD_PROMPT_EXECUTE,
    WIZARD_PROMPT_STREAM,
)
from app.services.wizard_db import WizardSkillPlan, wizard_db_service

logger = logging.getLogger(__name__)

router = APIRouter()
_FOLLOW_UP_VALIDATOR = TypeAdapter(FollowUpRequest)
_RECOMMEND_CONFIG_VALIDATOR = TypeAdapter(RecommendConfigRequest)
_GENERATE_PROMPT_VALIDATOR = TypeAdapter(GeneratePromptRequest)
_TEST_PROMPT_STREAM_VALIDATOR = TypeAdapter(TestPromptRequest)
_ITERATE_PROMPT_VALIDATOR = TypeAdapter(IteratePromptRequest)


def _request_body_openapi(schema: dict[str, Any]) -> dict[str, Any]:
    return {
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": schema}},
        }
    }


async def _decode_wizard_request(
    request: Request,
    validator: TypeAdapter,
) -> Any:
    return await validate_json_request(
        request,
        validator,
        max_bytes=WIZARD_BODY_MAX_BYTES,
    )


async def _decode_follow_up_request(request: Request) -> FollowUpRequest:
    return await _decode_wizard_request(request, _FOLLOW_UP_VALIDATOR)


async def _decode_recommend_config_request(request: Request) -> RecommendConfigRequest:
    return await _decode_wizard_request(request, _RECOMMEND_CONFIG_VALIDATOR)


async def _decode_generate_prompt_request(request: Request) -> GeneratePromptRequest:
    return await _decode_wizard_request(request, _GENERATE_PROMPT_VALIDATOR)


async def _decode_test_prompt_stream_request(
    request: Request,
) -> TestPromptRequest:
    return await _decode_wizard_request(request, _TEST_PROMPT_STREAM_VALIDATOR)


async def _decode_iterate_prompt_request(request: Request) -> IteratePromptRequest:
    return await _decode_wizard_request(request, _ITERATE_PROMPT_VALIDATOR)


def get_core_questions() -> List[CoreQuestion]:
    """Return simplified core questions for wizard step 1 - designed for non-technical users"""
    return [
        CoreQuestion(
            key="purpose",
            question="What do you want this AI assistant to help you with?",
            input_type="text",
            required=True,
            placeholder="e.g., Help me write weekly reports, answer customer questions, summarize meeting notes...",
        ),
        CoreQuestion(
            key="example_input",
            question="Give an example of what you would input",
            input_type="text",
            required=False,
            placeholder="e.g., Visited 5 clients this week, Signed 2 new contracts, Handled 3 customer service issues",
        ),
        CoreQuestion(
            key="expected_output",
            question="What kind of result do you expect from the AI?",
            input_type="text",
            required=False,
            placeholder="e.g., [Weekly Summary] 1. Client Visits: 5 total, 2 new clients 2. Sales Results: 2 contracts signed",
        ),
        CoreQuestion(
            key="special_requirements",
            question="Any preferences or things to note?",
            input_type="text",
            required=False,
            placeholder="e.g., Keep it brief, use formal language, include bullet points...",
        ),
    ]


@router.get("/core-questions", response_model=CoreQuestionsResponse)
def get_wizard_core_questions(
    current_user: User = Depends(security.get_current_user),
):
    """Get the 5 core questions for wizard step 1"""
    return CoreQuestionsResponse(questions=get_core_questions())


async def _call_llm_for_wizard(
    user_id: int,
    user_name: str,
    system_prompt: str,
    user_message: str,
    model_name: str | None = None,
) -> str:
    model_plan = await run_sync_in_executor(
        wizard_db_service.resolve_model_config,
        user_id,
        user_name,
        model_name,
        "No available models found. Please configure a model first, "
        "or set WIZARD_MODEL_NAME in environment variables.",
    )
    model_config = await run_payload_codec(
        dict,
        model_plan.config,
        payload_hint=model_plan.config,
        force_offload=True,
    )
    try:
        return await _execute_wizard_model(
            model_config,
            system_prompt,
            user_message,
        )
    except Exception as exc:
        logger.error("[Wizard] LLM call failed: %s", exc)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to generate response: {exc}",
        ) from exc


async def _execute_wizard_model(
    model_config: dict[str, Any],
    system_prompt: str,
    message: str | dict[str, Any],
) -> str:
    result = await web_stream_worker_client.execute(
        WIZARD_PROMPT_EXECUTE,
        {
            "message": message,
            "model_config": model_config,
            "system_prompt": system_prompt,
        },
    )
    response = result.get("response")
    if not isinstance(response, str):
        raise RuntimeError("Wizard model worker returned an invalid result")
    return response


def _skill_recommendation_prompts(
    plan: WizardSkillPlan,
    purpose: str,
    system_prompt: str,
) -> tuple[str, str] | None:
    skills_text = "\n".join(
        f"- {skill.name}: {skill.description}"
        for skill in plan.skill_info
        if skill.description
    )
    if not skills_text:
        return None
    recommend_system_prompt = """You are an expert at matching AI assistant capabilities with available skills.
Based on the user's purpose and the generated system prompt, recommend the most relevant skills.

IMPORTANT:
- Only recommend skills that are DIRECTLY relevant to the user's stated purpose
- Do NOT recommend skills just because they might be "nice to have"
- If no skills are clearly relevant, return an empty list
- Maximum 3 recommendations

Response format (JSON):
{
  "recommendations": [
    {"name": "skill-name", "reason": "Brief reason why this skill is relevant", "confidence": 0.9}
  ]
}

Output ONLY valid JSON, no other text."""
    recommend_user_message = f"""User's purpose: {purpose}

Generated system prompt:
{system_prompt[:500]}...

Available skills:
{skills_text}

Which skills would be most useful for this AI assistant? Only recommend skills that are directly relevant."""
    return recommend_system_prompt, recommend_user_message


def _skill_results(
    plan: WizardSkillPlan,
    recommendations: list[SkillRecommendation],
) -> tuple[list[AvailableSkill], list[SkillRecommendation]]:
    return list(plan.available_skills), list(recommendations)


def _parse_skill_recommendations(
    response: str,
    plan: WizardSkillPlan,
) -> list[SkillRecommendation]:
    json_match = re.search(r"\{[\s\S]*\}", response)
    result = json.loads(json_match.group() if json_match else response)
    by_name = {skill.name: skill for skill in plan.skill_info}
    recommendations: list[SkillRecommendation] = []
    for item in result.get("recommendations", []):
        matching = by_name.get(item.get("name"))
        if matching is None:
            continue
        recommendations.append(
            SkillRecommendation(
                name=matching.name,
                display_name=matching.display_name,
                description=matching.description,
                reason=item.get("reason", "Recommended for your use case"),
                confidence=item.get("confidence", 0.7),
                is_public=matching.is_public,
            )
        )
    return recommendations


async def _get_skills_for_wizard(
    user_id: int,
    user_name: str,
    purpose: str,
    system_prompt: str,
    shell_type: str,
) -> tuple[List[AvailableSkill], List[SkillRecommendation]]:
    plan = await run_sync_in_executor(
        wizard_db_service.load_skill_plan,
        user_id,
        shell_type,
    )
    if not plan.available_skills:
        return [], []
    prompts = await run_payload_codec(
        _skill_recommendation_prompts,
        plan,
        purpose,
        system_prompt,
        payload_hint=plan,
        force_offload=True,
    )
    if prompts is None:
        return list(plan.available_skills), []
    try:
        response = await _call_llm_for_wizard(
            user_id,
            user_name,
            prompts[0],
            prompts[1],
        )
        recommendations = await run_payload_codec(
            _parse_skill_recommendations,
            response,
            plan,
            payload_hint=response,
            force_offload=True,
        )
    except Exception as exc:
        logger.warning("[Wizard] Failed to get skill recommendations: %s", exc)
        recommendations = []
    return await run_payload_codec(
        _skill_results,
        plan,
        recommendations,
        payload_hint=(plan, recommendations),
        force_offload=True,
    )


def _parse_json_object(response: str) -> dict[str, Any]:
    json_match = re.search(r"\{[\s\S]*\}", response)
    result = json.loads(json_match.group() if json_match else response)
    if not isinstance(result, dict):
        raise json.JSONDecodeError("Expected a JSON object", response, 0)
    return result


def _followup_response(response: str, round_number: int) -> FollowUpResponse:
    result = _parse_json_object(response)
    return FollowUpResponse(
        questions=[
            FollowUpQuestion(
                question=item.get("question", ""),
                input_type=item.get("input_type", "text"),
                options=item.get("options"),
                default_answer=item.get("default_answer"),
            )
            for item in result.get("questions", [])
        ],
        is_complete=result.get("is_complete", False),
        round_number=round_number,
    )


def _default_followup_response(round_number: int) -> FollowUpResponse:
    return FollowUpResponse(
        questions=[
            FollowUpQuestion(
                question="Could you provide more details about your specific use case?",
                input_type="text",
            ),
            FollowUpQuestion(
                question="What level of expertise do you have in this domain?",
                input_type="single_choice",
                options=["Beginner", "Intermediate", "Expert"],
            ),
        ],
        is_complete=False,
        round_number=round_number,
    )


def _followup_user_message(request: FollowUpRequest) -> str:
    example_input = (
        request.answers.example_input
        or request.answers.example_task
        or request.answers.knowledge_domain
        or "Not specified"
    )
    expected_output = request.answers.expected_output or "Not specified"
    special_requirements = (
        request.answers.special_requirements or request.answers.constraints or "None"
    )
    answers = [
        "\nWhat the user wants help with: ",
        request.answers.purpose,
        "\nExample input they would provide: ",
        example_input,
        "\nExpected output format/content: ",
        expected_output,
        "\nSpecial requirements or preferences: ",
        special_requirements,
        "\n",
    ]
    if request.previous_followups:
        answers.append("\nPrevious follow-up answers:\n")
        for round_number, followup in enumerate(request.previous_followups, 1):
            answers.append(f"Round {round_number}:\n")
            for question, answer in followup.items():
                answers.append(f"  Q: {question}\n  A: {answer}\n")
    return f"""Current round: {request.round_number}
Maximum rounds allowed: 5

User's answers so far:
{''.join(answers)}

IMPORTANT:

- Output ONLY valid JSON, no other text
- Generate 3-5 focused questions in each round
- If the user's purpose and expected output are reasonably clear, set is_complete to true
- The user's examples are just references - create a GENERAL-PURPOSE assistant
- Do NOT ask about details, edge cases, or nice-to-have features"""


@router.post(
    "/generate-followup",
    response_model=FollowUpResponse,
    openapi_extra=_request_body_openapi(FollowUpRequest.model_json_schema()),
)
async def generate_followup_questions(
    request: FollowUpRequest = Depends(_decode_follow_up_request),
    current_user: User = Depends(security.get_current_user),
):
    """
    Generate AI-powered follow-up questions based on user answers.
    This endpoint is called for wizard step 2.
    Designed for non-technical users like operations, finance, sales staff.
    """
    user_id = current_user.id
    user_name = current_user.user_name or ""
    del current_user
    system_prompt = """You are a friendly AI assistant helping non-technical users (like operations staff, finance, sales, HR) create their own AI assistant.

Your goal is to ask ONLY the most essential follow-up questions to understand their core needs. Be efficient and focused.

CRITICAL Guidelines for Question Selection:
1. Ask 3-5 questions per round - focus on the most important gaps in understanding
2. Prioritize questions that clarify the CORE PURPOSE and EXPECTED OUTPUT
3. Skip questions if the user's initial description is already clear enough
4. Do NOT ask about edge cases, rare scenarios, or nice-to-have features
5. The user's examples are just references - focus on creating a GENERAL-PURPOSE assistant, not one tailored to specific examples

Question Priority (ask in this order, skip if already answered):
1. HIGHEST: What is the main goal/output? (if unclear)
2. HIGH: What format or style is preferred? (if output format matters)
3. MEDIUM: Any must-have requirements or constraints?
4. LOW: Skip detailed workflow questions - keep it general

IMPORTANT - Avoid Over-Questioning:
- If the user has clearly stated their purpose and expected output, you likely have enough information
- Do NOT ask about: frequency of use, who will read the output, detailed workflows, edge cases
- The goal is to create a VERSATILE assistant, not a hyper-specialized one
- HOWEVER: In round 1, you should ask at least 2-3 clarifying questions - never set is_complete to true in the first round

CRITICAL - Question Input Type Selection:
You MUST prefer choice-based questions (single_choice or multiple_choice) over text input whenever possible!

Use single_choice when:
- There are 2-5 clear, mutually exclusive options
- Asking about preferences, styles, formats, levels, or categories
- Examples: output format (简洁/详细), tone (正式/轻松), language style, expertise level

Use multiple_choice when:
- User can select multiple applicable options
- Asking about features, capabilities, or requirements that can combine
- Examples: output elements to include, types of content to handle, features needed

Use text input ONLY when:
- The answer is truly open-ended and cannot be categorized
- You need specific names, numbers, or unique information
- No reasonable set of options can cover the answer

Good question examples with CHOICE types:
- "你希望输出的风格是？" → single_choice: ["简洁明了", "详细完整", "要点列表", "正式报告"]
- "输出需要包含哪些元素？" → multiple_choice: ["标题", "摘要", "要点", "数据", "建议", "结论"]
- "你的专业水平是？" → single_choice: ["初学者", "有一定经验", "专业人士"]
- "AI助手的语气应该是？" → single_choice: ["专业正式", "友好亲切", "简洁直接", "耐心详细"]
- "需要处理哪些类型的内容？" → multiple_choice: ["文字", "数据", "表格", "代码", "图片描述"]

BAD examples (avoid these text questions):
- "你希望什么样的输出格式？" → Should be single_choice with options!
- "有什么特殊要求？" → Too vague, should be multiple_choice with common requirements
- "你的使用场景是什么？" → Should be single_choice with common scenarios

IMPORTANT - Provide Default Answers:
For EACH question, you MUST provide a reasonable default_answer based on the user's context:
- For single_choice questions: pick the most likely option as default
- For multiple_choice questions: pick the most common/relevant options as default (comma-separated)
- For text questions (use sparingly): suggest a sensible default based on what the user has described
- The default should be helpful but not overly specific - users can modify it if needed

Response format (JSON):
{
  "questions": [
    {"question": "Your simple question here", "input_type": "single_choice", "options": ["选项1", "选项2", "选项3"], "default_answer": "选项1"},
    {"question": "Another question", "input_type": "multiple_choice", "options": ["功能A", "功能B", "功能C", "功能D"], "default_answer": "功能A,功能B"},
    ...
  ],
  "is_complete": false (set to true if no more questions needed - PREFER true when basic info is clear)
}

IMPORTANT:
- Use the same language as the user's input (if Chinese, ask in Chinese)
- After round 5, you MUST set is_complete to true unless critical information is missing, or earlier if you have enough info
- ALWAYS provide a default_answer for each question - this helps users save time
- At least 80% of your questions should be single_choice or multiple_choice, NOT text!"""
    user_message = await run_payload_codec(
        _followup_user_message,
        request,
        payload_hint=request,
        force_offload=True,
    )

    try:
        response = await _call_llm_for_wizard(
            user_id, user_name, system_prompt, user_message
        )
        return await run_payload_codec(
            _followup_response,
            response,
            request.round_number,
            payload_hint=response,
            force_offload=True,
        )

    except json.JSONDecodeError:
        logger.error("Failed to parse wizard follow-up response as JSON")
        return await run_payload_codec(
            _default_followup_response,
            request.round_number,
            payload_hint=request.round_number,
            force_offload=True,
        )


@router.post(
    "/recommend-config",
    response_model=RecommendConfigResponse,
    openapi_extra=_request_body_openapi(RecommendConfigRequest.model_json_schema()),
)
async def recommend_shell_and_model(
    request: RecommendConfigRequest = Depends(_decode_recommend_config_request),
    current_user: User = Depends(security.get_current_user),
) -> RecommendConfigResponse:
    """Recommend a shell and model in the bounded DB worker."""
    user_id = current_user.id
    del current_user
    return await run_sync_in_executor(
        wizard_db_service.recommend_config,
        request,
        user_id,
    )


def _parse_generated_prompt(response: str) -> tuple[str, str, str, str]:
    result = _parse_json_object(response)
    return (
        str(result.get("system_prompt") or ""),
        str(result.get("suggested_name") or "my-agent"),
        str(result.get("suggested_description") or ""),
        str(result.get("sample_test_message") or ""),
    )


def _generate_prompt_response(
    fields: tuple[str, str, str, str],
    available_skills: list[AvailableSkill],
    recommended_skills: list[SkillRecommendation],
) -> GeneratePromptResponse:
    return GeneratePromptResponse(
        system_prompt=fields[0],
        suggested_name=fields[1],
        suggested_description=fields[2],
        sample_test_message=fields[3],
        recommended_skills=recommended_skills,
        available_skills=available_skills,
    )


def _default_prompt(request: GeneratePromptRequest) -> tuple[str, str]:
    example_task = (
        request.answers.example_task
        or request.answers.knowledge_domain
        or "general tasks"
    )
    special_reqs = (
        request.answers.special_requirements
        or request.answers.constraints
        or "None specified"
    )
    prompt = f"""# Your AI Assistant

I'm here to help you with: {request.answers.purpose}

## What I can do
- {example_task}

## How I work
- I'll be friendly and helpful
- I'll keep things simple and clear
- {special_reqs}
"""
    description = (
        request.answers.purpose[:100] if request.answers.purpose else "AI Assistant"
    )
    return prompt, description


def _default_generate_prompt_response(
    default_prompt: str,
    description: str,
    available_skills: list[AvailableSkill],
    recommended_skills: list[SkillRecommendation],
) -> GeneratePromptResponse:
    return GeneratePromptResponse(
        system_prompt=default_prompt,
        suggested_name="my-agent",
        suggested_description=description,
        sample_test_message="",
        recommended_skills=recommended_skills,
        available_skills=available_skills,
    )


def _generate_prompt_user_message(request: GeneratePromptRequest) -> str:
    example_input = (
        request.answers.example_input
        or request.answers.example_task
        or request.answers.knowledge_domain
        or "Not specified"
    )
    expected_output = request.answers.expected_output or "Not specified"
    special_requirements = (
        request.answers.special_requirements or request.answers.constraints or "None"
    )
    answers = [
        "\nWhat the user wants help with: ",
        request.answers.purpose,
        "\nExample input they would provide: ",
        example_input,
        "\nExpected output format/content: ",
        expected_output,
        "\nSpecial requirements or preferences: ",
        special_requirements,
        "\n",
    ]
    if request.followup_answers:
        answers.append("\nAdditional details from conversation:\n")
        for followup in request.followup_answers:
            for question, answer in followup.items():
                answers.append(f"- {question}: {answer}\n")
    return f"""Create a system prompt for an AI assistant based on these requirements:

{''.join(answers)}

IMPORTANT REMINDERS:
- The user's examples are just REFERENCES - create a GENERAL-PURPOSE assistant
- The assistant should handle ANY task in this category, not just the specific examples given
- Keep the prompt versatile and flexible
- This is for a non-technical user - make the prompt friendly and easy to understand"""


@router.post(
    "/generate-prompt",
    response_model=GeneratePromptResponse,
    openapi_extra=_request_body_openapi(GeneratePromptRequest.model_json_schema()),
)
async def generate_system_prompt(
    request: GeneratePromptRequest = Depends(_decode_generate_prompt_request),
    current_user: User = Depends(security.get_current_user),
):
    """
    Generate system prompt based on all collected answers.
    This endpoint is called for wizard step 4.
    """
    user_id = current_user.id
    user_name = current_user.user_name or ""
    del current_user
    system_prompt = """You are an expert at creating AI assistant configurations for non-technical users.
Based on the user's needs, create a friendly and effective system prompt.

CRITICAL - Create a GENERAL-PURPOSE Assistant:
The user's examples are just REFERENCES to help you understand their needs. Do NOT create an assistant that only handles those specific examples. Instead:
- Extract the GENERAL CATEGORY of tasks from the examples
- Create an assistant that can handle ANY task in that category
- The assistant should be VERSATILE and FLEXIBLE, not narrowly specialized

Example of what NOT to do:
- User example: "Help me write a weekly sales report"
- BAD prompt: "I help you write weekly sales reports with client visits and contracts"
- GOOD prompt: "I help you write various business reports and documents"

The prompt should be written in a way that:
1. Clearly defines the assistant's role in GENERAL terms (not tied to specific examples)
2. Lists CATEGORIES of tasks the assistant can help with (not specific instances)
3. Specifies how the assistant should communicate (friendly, professional, etc.)
4. Mentions any special requirements or things to avoid
5. Is easy to understand - avoid technical jargon

IMPORTANT - Wegent Platform Capabilities:
This AI assistant runs on Wegent, a conversation-based AI platform. Keep these capabilities in mind:

What Wegent CAN do well:
- Conversation-based Q&A and discussions
- Writing, editing, summarizing, and translating text
- Code development (with Git repository integration)
- Analyzing data provided in the conversation
- Generating documents, reports, and creative content
- Explaining concepts and providing guidance

What Wegent CANNOT do (unless specifically configured):
- Automatically access external systems or databases
- Perform scheduled/automated tasks without user interaction
- Access real-time internet data (unless web search is enabled)
- Interact with third-party applications directly

When creating the prompt:
- Focus on tasks achievable through conversation
- If the user's goal requires external data, guide the assistant to ask users to provide the information in chat
- Design realistic workflows within Wegent's conversation-based model
- Keep the assistant GENERAL and VERSATILE - it should handle various tasks in the same category

Also suggest a simple, memorable name and a brief description.

IMPORTANT - Generate a Sample Test Message:
Generate ONE sample test message that users can use to preview how the AI assistant would respond.

CRITICAL RULES for the test message - READ CAREFULLY:
- KEEP IT SHORT: The test message should be 50-150 characters max
- ONLY provide the RAW INPUT DATA or CONTENT - absolutely nothing else
- The message must start DIRECTLY with the actual data/content
- Do NOT include ANY introductory or framing text such as:
  - "以下是..." / "Here is..." / "Below is..."
  - "请根据..." / "Please..." / "请帮我..."
  - "我想要..." / "I want..." / "帮我..."
  - Any sentence that describes what the data is or what to do with it
- Do NOT include ANY of the following anywhere in the message:
  - Goals or objectives
  - Requirements or expectations (e.g., "要求...", "需要...", "希望...")
  - Instructions to the AI
  - Descriptions of what the user wants
  - Context-setting sentences
- The message should look like raw data that someone would directly paste
- Be in the same language as the user's input
- Be simple and concise - just enough to demonstrate the assistant's capability

Examples of GOOD vs BAD test messages:
- For a weekly report assistant:
  - BAD: "帮我写周报，要求简洁明了" (contains goal and requirement)
  - BAD: "以下是本周工作内容，请帮我整理成周报：拜访了5个客户" (contains framing text and instruction)
  - BAD: Long detailed content with multiple sections (too long)
  - GOOD: "本周拜访了5个客户，签了2份合同，处理了3个投诉" (short, pure data only)
- For a translation assistant:
  - BAD: "请帮我翻译这段话：Hello world" (contains instruction)
  - GOOD: "Hello world" (just the content to translate)
- For a code review assistant:
  - BAD: "请审查以下代码，检查是否有bug" (contains instruction and requirement)
  - GOOD: "def add(a, b): return a + b" (just the code)
- For a meeting summary assistant:
  - BAD: "请帮我总结会议内容，要点要清晰" (contains instruction and requirement)
  - GOOD: "张三介绍了Q3销售，李四提出新策略" (short meeting notes)

Response format (JSON):
{
  "system_prompt": "The full system prompt in markdown format",
  "suggested_name": "simple-name",
  "suggested_description": "A brief, friendly description of what this assistant does",
  "sample_test_message": "The actual input data/content for the assistant to process (NOT a description of the task)"
}

IMPORTANT:
- Use the same language as the user's input (if Chinese, respond in Chinese)
- Output ONLY valid JSON, no other text
- Keep the system_prompt clear and concise
- Use everyday language, not technical terms
- Ensure the assistant's capabilities align with what Wegent can actually do
- Create a GENERAL-PURPOSE assistant, NOT one tailored to specific examples
- Generate a meaningful sample test message that showcases the assistant's capabilities"""
    user_message = await run_payload_codec(
        _generate_prompt_user_message,
        request,
        payload_hint=request,
        force_offload=True,
    )

    try:
        response = await _call_llm_for_wizard(
            user_id, user_name, system_prompt, user_message
        )
        fields = await run_payload_codec(
            _parse_generated_prompt,
            response,
            payload_hint=response,
            force_offload=True,
        )
        generated_prompt = fields[0]

        # Get available skills and recommend skills based on user's purpose
        available_skills, recommended_skills = await _get_skills_for_wizard(
            user_id=user_id,
            user_name=user_name,
            purpose=request.answers.purpose,
            system_prompt=generated_prompt,
            shell_type=request.shell_type,
        )
        return await run_payload_codec(
            _generate_prompt_response,
            fields,
            available_skills,
            recommended_skills,
            payload_hint=(fields, available_skills, recommended_skills),
            force_offload=True,
        )

    except json.JSONDecodeError:
        logger.error("Failed to parse wizard prompt response as JSON")
        default_prompt, description = await run_payload_codec(
            _default_prompt,
            request,
            payload_hint=request,
            force_offload=True,
        )
        # Still try to get skills even if prompt generation failed
        try:
            available_skills, recommended_skills = await _get_skills_for_wizard(
                user_id=user_id,
                user_name=user_name,
                purpose=request.answers.purpose,
                system_prompt=default_prompt,
                shell_type=request.shell_type,
            )
        except Exception:
            available_skills = []
            recommended_skills = []

        return await run_payload_codec(
            _default_generate_prompt_response,
            default_prompt,
            description,
            available_skills,
            recommended_skills,
            payload_hint=(default_prompt, available_skills, recommended_skills),
            force_offload=True,
        )


@router.post("/create-all", response_model=CreateAllResponse)
async def create_all_resources(
    request: CreateAllRequest,
    current_user: User = Depends(security.get_current_user),
) -> CreateAllResponse:
    """Create Ghost, Bot, and Team atomically in the bounded DB worker."""
    user_id = current_user.id
    del current_user
    return await run_sync_in_executor(
        wizard_db_service.create_all,
        request,
        user_id,
    )


def _test_prompt_response(response: str, success: bool) -> TestPromptResponse:
    return TestPromptResponse(response=response, success=success)


@router.post(
    "/test-prompt",
    response_model=TestPromptResponse,
    openapi_extra=_request_body_openapi(TestPromptRequest.model_json_schema()),
)
async def test_system_prompt(
    request: TestPromptRequest = Depends(_decode_test_prompt_stream_request),
    current_user: User = Depends(security.get_current_user),
) -> TestPromptResponse:
    """Test a prompt without retaining user ORM state during the LLM call."""
    user_id = current_user.id
    user_name = current_user.user_name or ""
    del current_user
    try:
        model_plan = await run_sync_in_executor(
            wizard_db_service.resolve_model_config,
            user_id,
            user_name,
            request.model_name,
        )
        model_config = await run_payload_codec(
            dict,
            model_plan.config,
            payload_hint=model_plan.config,
            force_offload=True,
        )
        response = await _execute_wizard_model(
            model_config,
            request.system_prompt,
            request.test_message,
        )
        return await run_payload_codec(
            _test_prompt_response,
            response,
            True,
            payload_hint=response,
            force_offload=True,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[Wizard] Test prompt failed: %s", exc)
        return await run_payload_codec(
            _test_prompt_response,
            f"Test failed: {exc}",
            False,
            payload_hint=str(exc),
            force_offload=True,
        )


@router.post(
    "/test-prompt/stream",
    openapi_extra=_request_body_openapi(TestPromptRequest.model_json_schema()),
)
async def test_system_prompt_stream(
    request: TestPromptRequest = Depends(_decode_test_prompt_stream_request),
    current_user: User = Depends(security.get_current_user),
):
    """
    Test a system prompt with streaming response.
    This allows users to see the AI response in real-time
    before finalizing the configuration.
    """
    user_id = current_user.id
    user_name = current_user.user_name or ""
    message = request.test_message
    system_prompt = request.system_prompt
    model_name = request.model_name
    del current_user

    model_plan = await run_sync_in_executor(
        wizard_db_service.resolve_model_config,
        user_id,
        user_name,
        model_name,
    )
    model_config = await run_payload_codec(
        dict,
        model_plan.config,
        payload_hint=model_plan.config,
        force_offload=True,
    )

    return StreamingResponse(
        web_stream_worker_client.stream(
            WIZARD_PROMPT_STREAM,
            {
                "message": message,
                "model_config": model_config,
                "system_prompt": system_prompt,
            },
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Content-Encoding": "none",
        },
    )


def _iterate_prompt_response(
    response: str,
    current_prompt: str,
) -> IteratePromptResponse:
    result = _parse_json_object(response)
    return IteratePromptResponse(
        improved_prompt=result.get("improved_prompt", current_prompt),
        changes_summary=result.get(
            "changes_summary", "Prompt updated based on feedback."
        ),
    )


def _iterate_prompt_fallback(current_prompt: str) -> IteratePromptResponse:
    return IteratePromptResponse(
        improved_prompt=current_prompt,
        changes_summary=(
            "Could not parse the improvement. "
            "Please try again with different feedback."
        ),
    )


def _iterate_user_message(request: IteratePromptRequest) -> str:
    selected_text_section = ""
    if request.selected_text:
        selected_text_section = f"""
The user selected this specific part of the AI response:
>>> {request.selected_text} <<<

This selection helps you understand which part of the response the user's feedback refers to.
"""
    return f"""Here is the current system prompt:
---
{request.current_prompt}
---

The user tested it with this message:
"{request.test_message}"

The AI responded with:
---
{request.model_response}
---
{selected_text_section}
The user's feedback/request for changes:
"{request.user_feedback}"

Please improve the system prompt based on this feedback. The full response context above helps you understand the structure and location of the selected content."""


@router.post(
    "/iterate-prompt",
    response_model=IteratePromptResponse,
    openapi_extra=_request_body_openapi(IteratePromptRequest.model_json_schema()),
)
async def iterate_system_prompt(
    request: IteratePromptRequest = Depends(_decode_iterate_prompt_request),
    current_user: User = Depends(security.get_current_user),
):
    """
    Iterate and improve the system prompt based on user feedback.
    This allows users to refine the prompt by describing what they want changed.
    """
    user_id = current_user.id
    user_name = current_user.user_name or ""
    del current_user
    system_prompt = """You are an expert at improving AI assistant system prompts.
The user has tested their AI assistant and wants to make changes based on the results.

CRITICAL - Follow User Instructions with Smart Generalization:
The user's feedback is a DIRECT INSTRUCTION, but you must understand the INTENT behind it and generalize appropriately.

KEY PRINCIPLE - Generalize User Feedback:
When a user gives a specific example, understand the CATEGORY of change they want, not just the literal text.

Generalization Rules:
1. QUOTED UNWANTED TEXT → Generalize to the TYPE of content
   - User quotes an opening phrase they don't want → Remove ALL opening/introductory phrases
   - User quotes a filler sentence → Remove ALL similar filler content
   
2. SPECIFIC VALUE ASSIGNMENT → Use EXACT value
   - User says "X should be Y" → Change X to exactly Y, no interpretation
   - User provides a specific name/title → Use that exact name/title
   
3. STYLE/TONE FEEDBACK → Apply broadly
   - User wants more formal tone → Apply formal tone throughout
   - User wants shorter responses → Make the entire output more concise
   
4. STRUCTURAL FEEDBACK → Modify that specific structure
   - User says remove point 3 → Remove only point 3
   - User says add a section → Add that specific section

HOW TO DETERMINE GENERALIZATION LEVEL:
- Quoted phrase/sentence → Eliminate that TYPE of content (generalize)
- Specific value (name, title, number) → Use EXACT value (no generalization)
- Style description → Apply broadly (generalize)
- Structural reference → Modify specific structure (no generalization)

DO NOT:
- Add unrelated rules beyond the scope of user's feedback
- Over-engineer with excessive rules when a simple change suffices
- Interpret value assignments as preferences - they are direct commands
- Be too literal when user clearly means a category of content

Your task is to:
1. Understand the user's feedback and identify the INTENT
2. Determine if generalization is needed (specific example → general rule)
3. Make the appropriate change - generalized for examples, exact for values
4. Keep everything else in the prompt unchanged

Response format (JSON):
{
  "improved_prompt": "The full improved system prompt with the change applied",
  "changes_summary": "A brief summary of what was changed and why (mention if generalized)"
}

IMPORTANT:
- Use the same language as the original prompt
- Output ONLY valid JSON, no other text
- When user gives a specific example of unwanted content, add a GENERAL rule to avoid that type
- When user gives a specific value they want, use that EXACT value
- Treat user feedback as a command, but understand the underlying intent"""
    user_message = await run_payload_codec(
        _iterate_user_message,
        request,
        payload_hint=request,
        force_offload=True,
    )

    try:
        response = await _call_llm_for_wizard(
            user_id,
            user_name,
            system_prompt,
            user_message,
            request.model_name,
        )
        return await run_payload_codec(
            _iterate_prompt_response,
            response,
            request.current_prompt,
            payload_hint=response,
            force_offload=True,
        )

    except json.JSONDecodeError:
        logger.error("Failed to parse wizard iterate response as JSON")
        return await run_payload_codec(
            _iterate_prompt_fallback,
            request.current_prompt,
            payload_hint=request.current_prompt,
            force_offload=True,
        )
    except Exception as e:
        logger.error(f"[Wizard] Iterate prompt failed: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to iterate prompt: {str(e)}",
        )
