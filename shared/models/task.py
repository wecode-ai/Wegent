# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from pydantic import BaseModel
from typing import Optional, List, Dict, Any


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


class TasksRequest(BaseModel):
    tasks: List[Task]
