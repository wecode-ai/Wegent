# SPDX-FileCopyrightText: 2025 WeCode, Inc.
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
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
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
    RecommendConfigRequest,
    RecommendConfigResponse,
    ShellRecommendation,
    ModelRecommendation,
)
from app.services.chat.chat_service import chat_service
from app.services.chat.model_resolver import get_model_config_for_bot

logger = logging.getLogger(__name__)

router = APIRouter()


def get_core_questions() -> List[CoreQuestion]:
    """Return the 5 core questions for wizard step 1"""
    return [
        CoreQuestion(
            key="purpose",
            question="What do you want this agent to help you with?",
            input_type="text",
            required=True,
            placeholder="e.g., Help me write code, data analysis, content writing...",
        ),
        CoreQuestion(
            key="knowledge_domain",
            question="What areas should the agent specialize in?",
            input_type="text",
            required=False,
            placeholder="e.g., Frontend development, Python, Machine Learning...",
        ),
        CoreQuestion(
            key="interaction_style",
            question="What interaction style do you prefer?",
            input_type="single_choice",
            required=False,
            options=["Q&A Style", "Guided Style", "Proactive Style"],
        ),
        CoreQuestion(
            key="output_format",
            question="What output formats do you expect?",
            input_type="multiple_choice",
            required=False,
            options=["Code", "Documentation", "Lists", "Conversation", "Charts/Diagrams"],
        ),
        CoreQuestion(
            key="constraints",
            question="Are there any restrictions or things to avoid?",
            input_type="text",
            required=False,
            placeholder="e.g., Don't use certain libraries, avoid complex terminology...",
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
    """
    # Find a suitable model for the wizard
    # First try to find user's models
    user_models = (
        db.query(Kind)
        .filter(
            Kind.user_id == user.id,
            Kind.kind == "Model",
            Kind.is_active == True,
        )
        .all()
    )

    # If no user models, try public models
    if not user_models:
        user_models = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Model",
                Kind.is_active == True,
            )
            .all()
        )

    if not user_models:
        raise HTTPException(
            status_code=400,
            detail="No available models found. Please configure a model first.",
        )

    # Use the first available model
    model_kind = user_models[0]
    model_json = model_kind.json or {}
    model_spec = model_json.get("spec", {})
    model_config_data = model_spec.get("modelConfig", {})

    model_config = {
        "api_key": model_config_data.get("apiKey", ""),
        "base_url": model_config_data.get("baseUrl"),
        "model_id": model_config_data.get("modelId", ""),
        "protocol": model_spec.get("protocol", "openai"),
        "default_headers": model_config_data.get("defaultHeaders", {}),
    }

    # Use non-streaming chat
    try:
        response = await chat_service.chat_completion(
            message=user_message,
            model_config=model_config,
            system_prompt=system_prompt,
        )
        return response
    except Exception as e:
        logger.error(f"LLM call failed: {e}")
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
    """
    # Build context from answers
    answers_text = f"""
User's purpose: {request.answers.purpose}
Knowledge domain: {request.answers.knowledge_domain or 'Not specified'}
Interaction style: {request.answers.interaction_style or 'Not specified'}
Output formats: {', '.join(request.answers.output_format) if request.answers.output_format else 'Not specified'}
Constraints: {request.answers.constraints or 'None'}
"""

    # Add previous follow-up answers if any
    if request.previous_followups:
        answers_text += "\n\nPrevious follow-up answers:\n"
        for i, followup in enumerate(request.previous_followups, 1):
            answers_text += f"Round {i}:\n"
            for q, a in followup.items():
                answers_text += f"  Q: {q}\n  A: {a}\n"

    system_prompt = """You are an AI assistant helping to gather requirements for creating an AI agent.
Based on the user's answers, generate 2-3 follow-up questions to better understand their needs.

Guidelines:
1. Ask questions that help clarify ambiguous or incomplete information
2. Questions should be specific and actionable
3. Consider the user's use case and ask about details that would help create a better prompt
4. After 4-6 rounds, you should have enough information

Response format (JSON):
{
  "questions": [
    {"question": "Your question here", "input_type": "text|single_choice|multiple_choice", "options": ["option1", "option2"] (only for choice types)},
    ...
  ],
  "is_complete": false (set to true if no more questions needed)
}

IMPORTANT: Output ONLY valid JSON, no other text."""

    user_message = f"""Current round: {request.round_number}

User's answers so far:
{answers_text}

Generate follow-up questions to gather more details for creating their AI agent.
If you have enough information (usually after 4-6 rounds), set is_complete to true."""

    try:
        response = await _call_llm_for_wizard(
            db, current_user, system_prompt, user_message
        )

        # Parse JSON response
        # Try to extract JSON from the response
        json_match = re.search(r'\{[\s\S]*\}', response)
        if json_match:
            result = json.loads(json_match.group())
        else:
            result = json.loads(response)

        questions = [
            FollowUpQuestion(
                question=q.get("question", ""),
                input_type=q.get("input_type", "text"),
                options=q.get("options"),
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
    """
    # Analyze the purpose to determine shell type
    purpose_lower = request.answers.purpose.lower()
    domain_lower = (request.answers.knowledge_domain or "").lower()

    # Default recommendation
    shell_type = "Chat"
    shell_reason = "Suitable for general conversation and Q&A tasks"
    confidence = 0.7

    # Determine shell type based on keywords
    code_keywords = [
        "code", "coding", "programming", "develop", "debug", "bug", "fix",
        "implement", "build", "feature", "refactor", "test", "api",
        "frontend", "backend", "database", "script", "automation",
        "代码", "编程", "开发", "调试", "实现", "构建", "重构", "测试",
    ]

    complex_keywords = [
        "complex", "multi-step", "workflow", "pipeline", "coordinate",
        "collaborate", "team", "multiple agents",
        "复杂", "多步骤", "工作流", "协调", "协作", "团队",
    ]

    if any(kw in purpose_lower or kw in domain_lower for kw in code_keywords):
        shell_type = "ClaudeCode"
        shell_reason = "Best for code development, debugging, and repository exploration"
        confidence = 0.9
    elif any(kw in purpose_lower or kw in domain_lower for kw in complex_keywords):
        shell_type = "Agno"
        shell_reason = "Best for complex multi-agent collaboration and workflows"
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
                    reason="Anthropic models work best with Claude Code",
                    confidence=0.9,
                )
                break
            elif shell_type == "Agno" and protocol == "openai":
                model_recommendation = ModelRecommendation(
                    model_name=model.name,
                    model_id=model_spec.get("modelConfig", {}).get("modelId"),
                    reason="OpenAI compatible models work well with Agno",
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
                reason="Default available model",
                confidence=0.6,
            )

    # Build alternative shells
    alternative_shells = []
    for alt_type, alt_reason in [
        ("Chat", "Simple conversation without code execution"),
        ("ClaudeCode", "Code development with repository access"),
        ("Agno", "Multi-agent collaboration"),
    ]:
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
    # Build context
    answers_text = f"""
Purpose: {request.answers.purpose}
Knowledge domain: {request.answers.knowledge_domain or 'General'}
Interaction style: {request.answers.interaction_style or 'Q&A Style'}
Output formats: {', '.join(request.answers.output_format) if request.answers.output_format else 'Text'}
Constraints: {request.answers.constraints or 'None'}
Shell type: {request.shell_type}
"""

    if request.followup_answers:
        answers_text += "\nAdditional details:\n"
        for i, followup in enumerate(request.followup_answers, 1):
            for q, a in followup.items():
                answers_text += f"- {q}: {a}\n"

    system_prompt = """You are an expert at crafting AI agent system prompts.
Based on the user's requirements, create a well-structured system prompt.

The prompt should include:
1. Role definition - Who is this agent?
2. Capabilities - What can it do?
3. Output format - How should it respond?
4. Constraints - What should it avoid?
5. Interaction style - How should it communicate?

Also suggest a short name and description for this agent.

Response format (JSON):
{
  "system_prompt": "The full system prompt in markdown format",
  "suggested_name": "short-name-for-agent",
  "suggested_description": "Brief description of the agent"
}

IMPORTANT:
- Use the same language as the user's input (if Chinese, respond in Chinese)
- Output ONLY valid JSON, no other text
- The system_prompt should be comprehensive but not overly long"""

    user_message = f"""Create a system prompt for an AI agent based on these requirements:

{answers_text}

Generate a professional system prompt that will make this agent effective."""

    try:
        response = await _call_llm_for_wizard(
            db, current_user, system_prompt, user_message
        )

        # Parse JSON response
        json_match = re.search(r'\{[\s\S]*\}', response)
        if json_match:
            result = json.loads(json_match.group())
        else:
            result = json.loads(response)

        return GeneratePromptResponse(
            system_prompt=result.get("system_prompt", ""),
            suggested_name=result.get("suggested_name", "my-agent"),
            suggested_description=result.get("suggested_description", ""),
        )

    except json.JSONDecodeError:
        logger.error(f"Failed to parse LLM response: {response}")
        # Generate a default prompt if parsing fails
        default_prompt = f"""# Role Definition
You are an AI assistant specialized in {request.answers.knowledge_domain or 'general tasks'}.

# Capabilities
- Help with: {request.answers.purpose}
- Expertise in: {request.answers.knowledge_domain or 'various domains'}

# Output Format
{', '.join(request.answers.output_format) if request.answers.output_format else 'Clear and concise responses'}

# Interaction Style
{request.answers.interaction_style or 'Professional and helpful'}

# Constraints
{request.answers.constraints or 'None specified'}
"""
        return GeneratePromptResponse(
            system_prompt=default_prompt,
            suggested_name="my-agent",
            suggested_description=request.answers.purpose[:100] if request.answers.purpose else "AI Assistant",
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
            "agent_config": {},
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
                bot_spec["agent_config"]["bind_model"] = request.model_name
                bot_spec["agent_config"]["bind_model_type"] = request.model_type or "user"

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

        # Add additional fields
        team_data = team.json
        team_data["bind_mode"] = request.bind_mode
        team_data["icon"] = request.icon
        team_data["description"] = request.description
        team.json = team_data

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
