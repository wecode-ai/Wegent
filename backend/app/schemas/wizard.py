# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Wizard API schemas for agent creation wizard.
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class CoreQuestion(BaseModel):
    """Core question model for wizard step 1"""

    key: str
    question: str
    input_type: str  # text, single_choice, multiple_choice
    options: Optional[List[str]] = None
    required: bool = True
    placeholder: Optional[str] = None


class CoreQuestionsResponse(BaseModel):
    """Response containing core questions"""

    questions: List[CoreQuestion]


class WizardAnswers(BaseModel):
    """User answers to wizard questions - simplified for non-technical users"""

    purpose: str
    # Input/Output example fields for better understanding user needs
    example_input: Optional[str] = None
    expected_output: Optional[str] = None
    special_requirements: Optional[str] = None
    # Legacy fields for backward compatibility
    example_task: Optional[str] = None
    knowledge_domain: Optional[str] = None
    interaction_style: Optional[str] = None
    output_format: Optional[List[str]] = None
    constraints: Optional[str] = None


class FollowUpRequest(BaseModel):
    """Request for generating follow-up questions"""

    answers: WizardAnswers
    previous_followups: Optional[List[Dict[str, Any]]] = None
    round_number: int = 1


class FollowUpQuestion(BaseModel):
    """A single follow-up question"""

    question: str
    input_type: str  # text, single_choice, multiple_choice
    options: Optional[List[str]] = None
    default_answer: Optional[str] = None  # AI-suggested default answer


class FollowUpResponse(BaseModel):
    """Response containing follow-up questions"""

    questions: List[FollowUpQuestion]
    is_complete: bool = False  # True if no more questions needed
    round_number: int


class RecommendConfigRequest(BaseModel):
    """Request for shell/model recommendation"""

    answers: WizardAnswers
    followup_answers: Optional[List[Dict[str, Any]]] = None


class ShellRecommendation(BaseModel):
    """Shell recommendation with reason"""

    shell_name: str
    shell_type: str  # ClaudeCode, Agno, Chat, Dify
    reason: str
    confidence: float  # 0.0 - 1.0


class ModelRecommendation(BaseModel):
    """Model recommendation with reason"""

    model_name: str
    model_id: Optional[str] = None
    reason: str
    confidence: float


class RecommendConfigResponse(BaseModel):
    """Response containing shell and model recommendations"""

    shell: ShellRecommendation
    model: Optional[ModelRecommendation] = None
    alternative_shells: List[ShellRecommendation] = []
    alternative_models: List[ModelRecommendation] = []


class GeneratePromptRequest(BaseModel):
    """Request for generating system prompt"""

    answers: WizardAnswers
    followup_answers: Optional[List[Dict[str, Any]]] = None
    shell_type: str
    model_name: Optional[str] = None


class GeneratePromptResponse(BaseModel):
    """Response containing generated system prompt"""

    system_prompt: str
    suggested_name: str
    suggested_description: str
    sample_test_message: str = ""  # AI-generated sample test message for preview


class CreateAllRequest(BaseModel):
    """Request for creating Ghost + Bot + Team"""

    name: str
    description: Optional[str] = None
    system_prompt: str
    shell_name: str
    shell_type: str
    model_name: Optional[str] = None
    model_type: Optional[str] = None  # 'public' or 'user'
    bind_mode: List[str] = ["chat", "code"]
    namespace: str = "default"
    icon: Optional[str] = None


class CreateAllResponse(BaseModel):
    """Response after creating all resources"""

    team_id: int
    team_name: str
    bot_id: int
    bot_name: str
    ghost_id: int
    ghost_name: str
    message: str


class TestPromptRequest(BaseModel):
    """Request for testing system prompt with a sample task"""

    system_prompt: str
    test_message: str
    model_name: Optional[str] = None


class TestPromptResponse(BaseModel):
    """Response from testing system prompt"""

    response: str
    success: bool = True


class IteratePromptRequest(BaseModel):
    """Request for iterating/improving system prompt based on feedback"""

    current_prompt: str
    test_message: str
    model_response: str
    user_feedback: str
    selected_text: Optional[str] = None  # Text selected by user from model_response
    model_name: Optional[str] = None


class IteratePromptResponse(BaseModel):
    """Response containing improved system prompt"""

    improved_prompt: str
    changes_summary: str
