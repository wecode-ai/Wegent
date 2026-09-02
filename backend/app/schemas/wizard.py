# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Wizard API schemas for agent creation wizard.
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


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

    purpose: str = Field(min_length=1, max_length=64 * 1024)
    # Input/Output example fields for better understanding user needs
    example_input: Optional[str] = Field(default=None, max_length=64 * 1024)
    expected_output: Optional[str] = Field(default=None, max_length=64 * 1024)
    special_requirements: Optional[str] = Field(default=None, max_length=64 * 1024)
    # Legacy fields for backward compatibility
    example_task: Optional[str] = Field(default=None, max_length=64 * 1024)
    knowledge_domain: Optional[str] = Field(default=None, max_length=32 * 1024)
    interaction_style: Optional[str] = Field(default=None, max_length=32 * 1024)
    output_format: Optional[List[str]] = Field(default=None, max_length=64)
    constraints: Optional[str] = Field(default=None, max_length=64 * 1024)


class FollowUpRequest(BaseModel):
    """Request for generating follow-up questions"""

    answers: WizardAnswers
    previous_followups: Optional[List[Dict[str, Any]]] = Field(
        default=None,
        max_length=64,
    )
    round_number: int = Field(default=1, ge=1, le=32)


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
    followup_answers: Optional[List[Dict[str, Any]]] = Field(
        default=None,
        max_length=64,
    )


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
    followup_answers: Optional[List[Dict[str, Any]]] = Field(
        default=None,
        max_length=64,
    )
    shell_type: str = Field(min_length=1, max_length=64)
    model_name: Optional[str] = Field(default=None, max_length=256)


class AvailableSkill(BaseModel):
    """Available skill for selection"""

    name: str
    display_name: Optional[str] = None
    description: Optional[str] = None
    is_public: bool = False
    bind_shells: Optional[List[str]] = None


class SkillRecommendation(BaseModel):
    """Skill recommendation with reason"""

    name: str
    display_name: Optional[str] = None
    description: Optional[str] = None
    reason: str
    confidence: float  # 0.0 - 1.0
    is_public: bool = False


class GeneratePromptResponse(BaseModel):
    """Response containing generated system prompt"""

    system_prompt: str
    suggested_name: str
    suggested_description: str
    sample_test_message: str = ""  # AI-generated sample test message for preview
    recommended_skills: List[SkillRecommendation] = []  # AI-recommended skills
    available_skills: List[AvailableSkill] = []  # All available skills for selection


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
    skills: Optional[List[str]] = None  # Skill names to add to Ghost


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

    system_prompt: str = Field(max_length=256 * 1024)
    test_message: str = Field(max_length=256 * 1024)
    model_name: Optional[str] = Field(default=None, max_length=256)


class TestPromptResponse(BaseModel):
    """Response from testing system prompt"""

    response: str
    success: bool = True


class IteratePromptRequest(BaseModel):
    """Request for iterating/improving system prompt based on feedback"""

    current_prompt: str = Field(max_length=256 * 1024)
    test_message: str = Field(max_length=256 * 1024)
    model_response: str = Field(max_length=256 * 1024)
    user_feedback: str = Field(max_length=128 * 1024)
    selected_text: Optional[str] = Field(default=None, max_length=128 * 1024)
    model_name: Optional[str] = Field(default=None, max_length=256)


class IteratePromptResponse(BaseModel):
    """Response containing improved system prompt"""

    improved_prompt: str
    changes_summary: str


# Skill recommendation schemas (SkillRecommendation is defined above)


class RecommendSkillsRequest(BaseModel):
    """Request for skill recommendations"""

    answers: WizardAnswers
    followup_answers: Optional[List[Dict[str, Any]]] = Field(
        default=None,
        max_length=64,
    )
    system_prompt: str = Field(max_length=256 * 1024)
    shell_type: str = Field(min_length=1, max_length=64)
    namespace: str = Field(default="default", min_length=1, max_length=256)


class RecommendSkillsResponse(BaseModel):
    """Response containing skill recommendations"""

    recommended_skills: List[SkillRecommendation]
    available_skills: List[SkillRecommendation]
