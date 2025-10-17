# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from pydantic import Field


class User(BaseModel):
    id: int
    name: str
    git_domain: Optional[str] = None
    git_token: Optional[str] = None


class Bot(BaseModel):
    id: int
    name: str
    agent_name: str
    agent_config: Optional[Dict[str, Any]] = None
    system_prompt: Optional[str] = None
    mcp_servers: Optional[Dict[str, Any]] = None


class Task(BaseModel):
    subtask_id: int
    subtask_next_id: Optional[int] = None
    task_id: int
    subtask_title: Optional[str] = None
    task_title: Optional[str] = None
    user: User
    bot: Bot
    team_id: int
    git_domain: str
    git_repo: str
    git_repo_id: int
    branch_name: str
    git_url: str
    prompt: str
    status: str
    progress: int


class ThinkingStep(BaseModel):
    """Thinking step model for recording agent reasoning process"""
    title: str = Field(..., description="Title of the thinking step")
    action: str = Field(..., description="Action description of the thinking step")
    result: str = Field(default="", description="Result of the thinking step")
    reasoning: str = Field(..., description="Reasoning process of the thinking step")
    confidence: float = Field(default=0.5, description="Confidence level of the thinking step (0.0-1.0)")
    next_action: str = Field(default="continue", description="Next action to take")
    
    def dict(self, **kwargs) -> Dict[str, Any]:
        """重写 dict 方法，排除 None 值"""
        # 默认排除 None 值
        kwargs.setdefault('exclude_none', True)
        return super().dict(**kwargs)


class ExecutionResult(BaseModel):
    value: Optional[str] = None
    thinking: List[ThinkingStep] = []
    
    def dict(self, **kwargs) -> Dict[str, Any]:
        """重写 dict 方法，排除 None 值"""
        # 默认排除 None 值
        kwargs.setdefault('exclude_none', True)
        return super().dict(**kwargs)


class TasksRequest(BaseModel):
    tasks: List[Task]
