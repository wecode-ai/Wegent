# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Wizard API endpoints for agent creation wizard.

This module provides APIs for the step-by-step agent creation wizard,
including AI-powered follow-up questions and prompt generation.
"""

import asyncio
import json
import logging
import re
from typing import Any, AsyncGenerator, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.config import settings
from app.models.kind import Kind
from app.models.user import User
from app.schemas.kind import Bot, Ghost, Shell, Team
from app.schemas.wizard import (
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
    ModelRecommendation,
    RecommendConfigRequest,
    RecommendConfigResponse,
    ShellRecommendation,
    TestPromptRequest,
    TestPromptResponse,
)
from app.services.chat.config import extract_and_process_model_config
from app.services.simple_chat import simple_chat_service

logger = logging.getLogger(__name__)

router = APIRouter()


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
async def get_wizard_core_questions(
    current_user: User = Depends(security.get_current_user),
):
    """Get the 5 core questions for wizard step 1"""
    return CoreQuestionsResponse(questions=get_core_questions())


async def _call_llm_for_wizard(
    db: Session,
    user: User,
    system_prompt: str,
    user_message: str,
) -> str:
    """
    Call LLM for wizard functionality using an available model.
    Returns the LLM response as a string.

    Model selection priority:
    1. If WIZARD_MODEL_NAME is configured, use that public model
    2. Otherwise, try user's models first
    3. Fall back to any available public model
    """
    model_kind = None

    logger.info(
        f"[Wizard] Looking for model. WIMODEL_NAME={settings.WIZARD_MODEL_NAME}, "
        f"user_id={user.id}"
    )

    # Priority 1: Use configured wizard model if specified
    if settings.WIZARD_MODEL_NAME:
        logger.info(
            f"[Wizard] Priority 1: Looking for configured model '{settings.WIZARD_MODEL_NAME}'"
        )
        model_kind = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,  # Public model
                Kind.kind == "Model",
                Kind.name == settings.WIZARD_MODEL_NAME,
                Kind.is_active == True,
            )
            .first()
        )
        if model_kind:
            logger.info(f"[Wizard] Found configured model: {model_kind.name}")
        else:
            logger.warning(
                f"[Wizard] Configured WIZARD_MODEL_NAME '{settings.WIZARD_MODEL_NAME}' not found, "
                "falling back to other available models"
            )

    # Priority 2: Try user's models
    if not model_kind:
        logger.info(
            f"[Wizard] Priority 2: Looking for user's models (user_id={user.id})"
        )
        user_models = (
            db.query(Kind)
            .filter(
                Kind.user_id == user.id,
                Kind.kind == "Model",
                Kind.is_active == True,
            )
            .all()
        )
        logger.info(
            f"[Wizard] Found {len(user_models)} user models: {[m.name for m in user_models]}"
        )
        if user_models:
            model_kind = user_models[0]
            logger.info(f"[Wizard] Using user model: {model_kind.name}")

    # Priority 3: Fall back to any public model
    if not model_kind:
        logger.info("[Wizard] Priority 3: Looking for any public model (user_id=0)")
        public_models = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Model",
                Kind.is_active == True,
            )
            .all()
        )
        logger.info(
            f"[Wizard] Found {len(public_models)} public models: {[m.name for m in public_models]}"
        )
        if public_models:
            model_kind = public_models[0]
            logger.info(f"[Wizard] Using public model: {model_kind.name}")

    if not model_kind:
        # Log all models in the database for debugging
        all_models = db.query(Kind).filter(Kind.kind == "Model").all()
        logger.error(
            f"[Wizard] No available models found! "
            f"All models in DB: {[(m.id, m.name, m.user_id, m.is_active) for m in all_models]}"
        )
        raise HTTPException(
            status_code=400,
            detail="No available models found. Please configure a model first, "
            "or set WIZARD_MODEL_NAME in environment variables.",
        )

    model_json = model_kind.json or {}
    logger.info(f"[Wizard] Model '{model_kind.name}' found, extracting config...")
    model_spec = model_json.get("spec", {})

    # Extract model config and process all placeholders (api_key, default_headers)
    # The extract_and_process_model_config function handles both api_key and
    # default_headers placeholder replacement internally
    model_config = extract_and_process_model_config(
        model_spec=model_spec,
        user_id=user.id,
        user_name=user.user_name or "",
    )

    logger.info(
        f"[Wizard] Extracted model config - model={model_config.get('model')}, "
        f"base_url={model_config.get('base_url')}, model_id={model_config.get('model_id')}, "
        f"has_api_key={bool(model_config.get('api_key'))}"
    )

    # Use non-streaming chat
    try:
        response = await simple_chat_service.chat_completion(
            message=user_message,
            model_config=model_config,
            system_prompt=system_prompt,
        )
        return response
    except Exception as e:
        logger.error(f"[Wizard] LLM call failed: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to generate response: {str(e)}",
        )


@router.post("/generate-followup", response_model=FollowUpResponse)
async def generate_followup_questions(
    request: FollowUpRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Generate AI-powered follow-up questions based on user answers.
    This endpoint is called for wizard step 2.
    Designed for non-technical users like operations, finance, sales staff.
    """
    # Build context from answers - using input/output example fields
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

    answers_text = f"""
What the user wants help with: {request.answers.purpose}
Example input they would provide: {example_input}
Expected output format/content: {expected_output}
Special requirements or preferences: {special_requirements}
"""

    # Add previous follow-up answers if any
    if request.previous_followups:
        answers_text += "\n\nPrevious follow-up answers:\n"
        for i, followup in enumerate(request.previous_followups, 1):
            answers_text += f"Round {i}:\n"
            for q, a in followup.items():
                answers_text += f"  Q: {q}\n  A: {a}\n"

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

    user_message = f"""Current round: {request.round_number}
Maximum rounds allowed: 5 

User's answers so far:
{answers_text}

IMPORTANT:

- Output ONLY valid JSON, no other text
- Generate 3-5 focused questions in each round
- If the user's purpose and expected output are reasonably clear, set is_complete to true
- The user's examples are just references - create a GENERAL-PURPOSE assistant
- Do NOT ask about details, edge cases, or nice-to-have features"""

    try:
        response = await _call_llm_for_wizard(
            db, current_user, system_prompt, user_message
        )

        # Parse JSON response
        # Try to extract JSON from the response
        json_match = re.search(r"\{[\s\S]*\}", response)
        if json_match:
            result = json.loads(json_match.group())
        else:
            result = json.loads(response)

        questions = [
            FollowUpQuestion(
                question=q.get("question", ""),
                input_type=q.get("input_type", "text"),
                options=q.get("options"),
                default_answer=q.get("default_answer"),
            )
            for q in result.get("questions", [])
        ]

        return FollowUpResponse(
            questions=questions,
            is_complete=result.get("is_complete", False),
            round_number=request.round_number,
        )

    except json.JSONDecodeError:
        logger.error(f"Failed to parse LLM response as JSON: {response}")
        # Return default questions if parsing fails
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
            round_number=request.round_number,
        )


@router.post("/recommend-config", response_model=RecommendConfigResponse)
async def recommend_shell_and_model(
    request: RecommendConfigRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Recommend Shell and Model based on user's answers.
    This endpoint is called for wizard step 3.
    For non-technical users, we use friendly descriptions instead of technical terms.
    """
    # Analyze the purpose to determine shell type
    purpose_lower = request.answers.purpose.lower()
    # Support both old and new field names - example_input is the new primary field
    example_input = (
        request.answers.example_input
        or request.answers.example_task
        or request.answers.knowledge_domain
        or ""
    )
    expected_output = request.answers.expected_output or ""
    example_text_lower = (example_input + " " + expected_output).lower()

    # Default recommendation - Chat mode for most non-technical users
    shell_type = "Chat"
    shell_reason = "Perfect for everyday conversations and quick Q&A"
    shell_reason_friendly = "Best for chatting and getting quick answers"
    confidence = 0.85  # Higher confidence for Chat as default for non-tech users

    # Determine shell type based on keywords
    code_keywords = [
        "code",
        "coding",
        "programming",
        "develop",
        "debug",
        "bug",
        "fix",
        "implement",
        "build",
        "feature",
        "refactor",
        "test",
        "api",
        "frontend",
        "backend",
        "database",
        "script",
        "automation",
        "代码",
        "编程",
        "开发",
        "调试",
        "实现",
        "构建",
        "重构",
        "测试",
    ]

    complex_keywords = [
        "complex",
        "multi-step",
        "workflow",
        "pipeline",
        "coordinate",
        "collaborate",
        "team",
        "multiple agents",
        "复杂",
        "多步骤",
        "工作流",
        "协调",
        "协作",
        "团队",
    ]

    if any(kw in purpose_lower or kw in example_text_lower for kw in code_keywords):
        shell_type = "ClaudeCode"
        shell_reason = "Ideal for working with code and technical projects"
        shell_reason_friendly = "Best for coding and technical work"
        confidence = 0.9
    elif any(
        kw in purpose_lower or kw in example_text_lower for kw in complex_keywords
    ):
        shell_type = "Agno"
        shell_reason = "Great for complex tasks that need multiple steps"
        shell_reason_friendly = "Best for complex multi-step tasks"
        confidence = 0.85

    # Get available shells
    available_shells = (
        db.query(Kind)
        .filter(
            Kind.kind == "Shell",
            Kind.is_active == True,
            ((Kind.user_id == current_user.id) | (Kind.user_id == 0)),
        )
        .all()
    )

    # Find a matching shell
    shell_name = shell_type.lower()
    for shell in available_shells:
        shell_json = shell.json or {}
        shell_spec = shell_json.get("spec", {})
        if shell_spec.get("shellType") == shell_type:
            shell_name = shell.name
            break

    # Get available models for recommendation
    available_models = (
        db.query(Kind)
        .filter(
            Kind.kind == "Model",
            Kind.is_active == True,
            ((Kind.user_id == current_user.id) | (Kind.user_id == 0)),
        )
        .all()
    )

    model_recommendation = None
    alternative_models = []

    if available_models:
        # Recommend based on shell type
        for model in available_models:
            model_json = model.json or {}
            model_spec = model_json.get("spec", {})
            protocol = model_spec.get("protocol", "openai")

            if shell_type == "ClaudeCode" and protocol == "anthropic":
                model_recommendation = ModelRecommendation(
                    model_name=model.name,
                    model_id=model_spec.get("modelConfig", {}).get("modelId"),
                    reason="Recommended for this type of work",
                    confidence=0.9,
                )
                break
            elif shell_type == "Agno" and protocol == "openai":
                model_recommendation = ModelRecommendation(
                    model_name=model.name,
                    model_id=model_spec.get("modelConfig", {}).get("modelId"),
                    reason="Works great for complex tasks",
                    confidence=0.85,
                )
                break

        # If no specific match, use the first available
        if not model_recommendation and available_models:
            model = available_models[0]
            model_json = model.json or {}
            model_spec = model_json.get("spec", {})
            model_recommendation = ModelRecommendation(
                model_name=model.name,
                model_id=model_spec.get("modelConfig", {}).get("modelId"),
                reason="Ready to use",
                confidence=0.7,
            )

    # Build alternative shells with user-friendly descriptions
    alternative_shells = []
    friendly_shell_info = {
        "Chat": (
            "Simple and fast conversations",
            "Best for quick Q&A and everyday tasks",
        ),
        "ClaudeCode": (
            "For coding and technical work",
            "Best when you need to work with code",
        ),
        "Agno": (
            "For complex multi-step tasks",
            "Best for tasks that need multiple steps",
        ),
    }

    for alt_type, (alt_reason, _) in friendly_shell_info.items():
        if alt_type != shell_type:
            alternative_shells.append(
                ShellRecommendation(
                    shell_name=alt_type.lower(),
                    shell_type=alt_type,
                    reason=alt_reason,
                    confidence=0.5,
                )
            )

    return RecommendConfigResponse(
        shell=ShellRecommendation(
            shell_name=shell_name,
            shell_type=shell_type,
            reason=shell_reason,
            confidence=confidence,
        ),
        model=model_recommendation,
        alternative_shells=alternative_shells,
        alternative_models=alternative_models,
    )


@router.post("/generate-prompt", response_model=GeneratePromptResponse)
async def generate_system_prompt(
    request: GeneratePromptRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Generate system prompt based on all collected answers.
    This endpoint is called for wizard step 4.
    """
    # Build context - using input/output example fields
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

    answers_text = f"""
What the user wants help with: {request.answers.purpose}
Example input they would provide: {example_input}
Expected output format/content: {expected_output}
Special requirements or preferences: {special_requirements}
"""

    if request.followup_answers:
        answers_text += "\nAdditional details from conversation:\n"
        for i, followup in enumerate(request.followup_answers, 1):
            for q, a in followup.items():
                answers_text += f"- {q}: {a}\n"

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

    user_message = f"""Create a system prompt for an AI assistant based on these requirements:

{answers_text}

IMPORTANT REMINDERS:
- The user's examples are just REFERENCES - create a GENERAL-PURPOSE assistant
- The assistant should handle ANY task in this category, not just the specific examples given
- Keep the prompt versatile and flexible
- This is for a non-technical user - make the prompt friendly and easy to understand"""

    try:
        response = await _call_llm_for_wizard(
            db, current_user, system_prompt, user_message
        )

        # Parse JSON response
        json_match = re.search(r"\{[\s\S]*\}", response)
        if json_match:
            result = json.loads(json_match.group())
        else:
            result = json.loads(response)

        return GeneratePromptResponse(
            system_prompt=result.get("system_prompt", ""),
            suggested_name=result.get("suggested_name", "my-agent"),
            suggested_description=result.get("suggested_description", ""),
            sample_test_message=result.get("sample_test_message", ""),
        )

    except json.JSONDecodeError:
        logger.error(f"Failed to parse LLM response: {response}")
        # Generate a default prompt if parsing fails - using simplified fields
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

        default_prompt = f"""# Your AI Assistant

I'm here to help you with: {request.answers.purpose}

## What I can do
- {example_task}

## How I work
- I'll be friendly and helpful
- I'll keep things simple and clear
- {special_reqs}
"""
        return GeneratePromptResponse(
            system_prompt=default_prompt,
            suggested_name="my-agent",
            suggested_description=(
                request.answers.purpose[:100]
                if request.answers.purpose
                else "AI Assistant"
            ),
            sample_test_message="",
        )


@router.post("/create-all", response_model=CreateAllResponse)
async def create_all_resources(
    request: CreateAllRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Create Ghost + Bot + Team in one transaction.
    This endpoint is called for wizard step 5.
    """
    try:
        # 1. Create Ghost
        ghost_name = f"{request.name}-ghost"
        ghost_json = {
            "kind": "Ghost",
            "apiVersion": "agent.wecode.io/v1",
            "metadata": {
                "name": ghost_name,
                "namespace": request.namespace,
            },
            "spec": {
                "systemPrompt": request.system_prompt,
                "mcpServers": {},
                "skills": [],
            },
        }

        ghost = Kind(
            user_id=current_user.id,
            kind="Ghost",
            name=ghost_name,
            namespace=request.namespace,
            json=ghost_json,
            is_active=True,
        )
        db.add(ghost)
        db.flush()  # Get ghost.id

        # 2. Find the shell
        shell = (
            db.query(Kind)
            .filter(
                Kind.kind == "Shell",
                Kind.is_active == True,
                ((Kind.user_id == current_user.id) | (Kind.user_id == 0)),
                Kind.name == request.shell_name,
            )
            .first()
        )

        # If not found by name, try to find by shell type
        if not shell:
            shells = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Shell",
                    Kind.is_active == True,
                    ((Kind.user_id == current_user.id) | (Kind.user_id == 0)),
                )
                .all()
            )
            for s in shells:
                s_json = s.json or {}
                if s_json.get("spec", {}).get("shellType") == request.shell_type:
                    shell = s
                    break

        if not shell:
            raise HTTPException(
                status_code=400,
                detail=f"Shell '{request.shell_name}' not found",
            )

        # 3. Create Bot
        bot_name = f"{request.name}-bot"
        bot_spec = {
            "ghostRef": {
                "name": ghost_name,
                "namespace": request.namespace,
            },
            "shellRef": {
                "name": shell.name,
                "namespace": shell.namespace,
            },
        }

        # Add model reference if specified
        if request.model_name:
            model = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Model",
                    Kind.is_active == True,
                    Kind.name == request.model_name,
                    ((Kind.user_id == current_user.id) | (Kind.user_id == 0)),
                )
                .first()
            )
            if model:
                # Set modelRef to point to the selected model
                bot_spec["modelRef"] = {
                    "name": request.model_name,
                    "namespace": model.namespace,
                }

        bot_json = {
            "kind": "Bot",
            "apiVersion": "agent.wecode.io/v1",
            "metadata": {
                "name": bot_name,
                "namespace": request.namespace,
            },
            "spec": bot_spec,
        }

        bot = Kind(
            user_id=current_user.id,
            kind="Bot",
            name=bot_name,
            namespace=request.namespace,
            json=bot_json,
            is_active=True,
        )
        db.add(bot)
        db.flush()  # Get bot.id

        # 4. Create Team
        team_json = {
            "kind": "Team",
            "apiVersion": "agent.wecode.io/v1",
            "metadata": {
                "name": request.name,
                "namespace": request.namespace,
            },
            "spec": {
                "members": [
                    {
                        "botRef": {
                            "name": bot_name,
                            "namespace": request.namespace,
                        },
                        "role": "leader",
                        "prompt": "",
                    }
                ],
                "collaborationModel": "solo",
                "bind_mode": request.bind_mode,
                "description": request.description,
                "icon": request.icon,
            },
        }

        team = Kind(
            user_id=current_user.id,
            kind="Team",
            name=request.name,
            namespace=request.namespace,
            json=team_json,
            is_active=True,
        )

        db.add(team)
        db.commit()

        db.refresh(ghost)
        db.refresh(bot)
        db.refresh(team)

        return CreateAllResponse(
            team_id=team.id,
            team_name=team.name,
            bot_id=bot.id,
            bot_name=bot.name,
            ghost_id=ghost.id,
            ghost_name=ghost.name,
            message="Agent created successfully!",
        )

    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Failed to create resources: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to create agent: {str(e)}",
        )


@router.post("/test-prompt", response_model=TestPromptResponse)
async def test_system_prompt(
    request: TestPromptRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Test a system prompt with a sample task message.
    This allows users to see how the AI assistant would respond
    before finalizing the configuration.
    """
    try:
        # Find the model to use for testing
        model_kind = None

        if request.model_name:
            model_kind = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Model",
                    Kind.is_active == True,
                    Kind.name == request.model_name,
                    ((Kind.user_id == current_user.id) | (Kind.user_id == 0)),
                )
                .first()
            )

        # Fall back to wizard model selection logic
        if not model_kind:
            if settings.WIZARD_MODEL_NAME:
                model_kind = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id == 0,
                        Kind.kind == "Model",
                        Kind.name == settings.WIZARD_MODEL_NAME,
                        Kind.is_active == True,
                    )
                    .first()
                )

            if not model_kind:
                user_models = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id == current_user.id,
                        Kind.kind == "Model",
                        Kind.is_active == True,
                    )
                    .all()
                )
                if user_models:
                    model_kind = user_models[0]

            if not model_kind:
                public_models = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id == 0,
                        Kind.kind == "Model",
                        Kind.is_active == True,
                    )
                    .all()
                )
                if public_models:
                    model_kind = public_models[0]

        if not model_kind:
            raise HTTPException(
                status_code=400,
                detail="No available models found for testing.",
            )

        model_json = model_kind.json or {}
        model_spec = model_json.get("spec", {})
        model_config = extract_and_process_model_config(
            model_spec=model_spec,
            user_id=current_user.id,
            user_name=current_user.user_name or "",
        )

        # Call the model with the user's system prompt and test message
        response = await simple_chat_service.chat_completion(
            message=request.test_message,
            model_config=model_config,
            system_prompt=request.system_prompt,
        )

        return TestPromptResponse(
            response=response,
            success=True,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Wizard] Test prompt failed: {e}")
        return TestPromptResponse(
            response=f"Test failed: {str(e)}",
            success=False,
        )


def _get_model_for_wizard(
    db: Session,
    user: User,
    model_name: Optional[str] = None,
) -> Kind:
    """
    Get model for wizard functionality.

    Model selection priority:
    1. If model_name is specified, use that model
    2. If WIZARD_MODEL_NAME is configured, use that public model
    3. Otherwise, try user's models first
    4. Fall back to any available public model
    """
    model_kind = None

    # Priority 0: Use specified model if provided
    if model_name:
        model_kind = (
            db.query(Kind)
            .filter(
                Kind.kind == "Model",
                Kind.is_active == True,
                Kind.name == model_name,
                ((Kind.user_id == user.id) | (Kind.user_id == 0)),
            )
            .first()
        )
        if model_kind:
            return model_kind

    # Priority 1: Use configured wizard model if specified
    if settings.WIZARD_MODEL_NAME:
        model_kind = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,  # Public model
                Kind.kind == "Model",
                Kind.name == settings.WIZARD_MODEL_NAME,
                Kind.is_active == True,
            )
            .first()
        )
        if model_kind:
            return model_kind

    # Priority 2: Try user's models
    user_models = (
        db.query(Kind)
        .filter(
            Kind.user_id == user.id,
            Kind.kind == "Model",
            Kind.is_active == True,
        )
        .all()
    )
    if user_models:
        return user_models[0]

    # Priority 3: Fall back to any public model
    public_models = (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Model",
            Kind.is_active == True,
        )
        .all()
    )
    if public_models:
        return public_models[0]

    raise HTTPException(
        status_code=400,
        detail="No available models found for testing.",
    )


@router.post("/test-prompt/stream")
async def test_system_prompt_stream(
    request: TestPromptRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Test a system prompt with streaming response.
    This allows users to see the AI response in real-time
    before finalizing the configuration.
    """
    # Get model for testing
    model_kind = _get_model_for_wizard(db, current_user, request.model_name)

    model_json = model_kind.json or {}
    model_spec = model_json.get("spec", {})
    model_config = extract_and_process_model_config(
        model_spec=model_spec,
        user_id=current_user.id,
        user_name=current_user.user_name or "",
    )

    # Use simple_chat_service.chat_stream in simple mode (no subtask_id/task_id)
    return await simple_chat_service.chat_stream(
        message=request.test_message,
        model_config=model_config,
        system_prompt=request.system_prompt,
    )


@router.post("/iterate-prompt", response_model=IteratePromptResponse)
async def iterate_system_prompt(
    request: IteratePromptRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Iterate and improve the system prompt based on user feedback.
    This allows users to refine the prompt by describing what they want changed.
    """
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

    # Build user message with optional selected text context
    selected_text_section = ""
    if request.selected_text:
        selected_text_section = f"""
The user selected this specific part of the AI response:
>>> {request.selected_text} <<<

This selection helps you understand which part of the response the user's feedback refers to.
"""

    user_message = f"""Here is the current system prompt:
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

    try:
        response = await _call_llm_for_wizard(
            db, current_user, system_prompt, user_message
        )

        # Parse JSON response
        json_match = re.search(r"\{[\s\S]*\}", response)
        if json_match:
            result = json.loads(json_match.group())
        else:
            result = json.loads(response)

        return IteratePromptResponse(
            improved_prompt=result.get("improved_prompt", request.current_prompt),
            changes_summary=result.get(
                "changes_summary", "Prompt updated based on feedback."
            ),
        )

    except json.JSONDecodeError:
        logger.error(f"Failed to parse iterate prompt response: {response}")
        # Return the original prompt with a note
        return IteratePromptResponse(
            improved_prompt=request.current_prompt,
            changes_summary="Could not parse the improvement. Please try again with different feedback.",
        )
    except Exception as e:
        logger.error(f"[Wizard] Iterate prompt failed: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to iterate prompt: {str(e)}",
        )
