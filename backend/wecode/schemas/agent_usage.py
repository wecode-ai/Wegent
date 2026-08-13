# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import date

from pydantic import BaseModel, Field


class AgentUsageAgent(BaseModel):
    name: str
    namespace: str
    owner_user_id: int
    author_name: str
    is_owner: bool = False


class AgentUsageAgentPage(BaseModel):
    items: list[AgentUsageAgent]
    has_more: bool
    next_offset: int


class AgentUsageQuery(BaseModel):
    start_date: date
    end_date: date
    agents: list[AgentUsageAgent] = Field(default_factory=list, max_length=100)


class AgentUsageRow(BaseModel):
    agent_name: str
    agent_namespace: str
    author_name: str
    pv: int
    uv: int
    ai_rounds: int | None = None
    completed_ai_rounds: int | None = None


class AgentUsageDailyRow(BaseModel):
    date: date
    agent_name: str
    agent_namespace: str
    pv: int
    uv: int
    ai_rounds: int | None = None
    completed_ai_rounds: int | None = None


class AgentUsageResponse(BaseModel):
    rows: list[AgentUsageRow]
    daily_rows: list[AgentUsageDailyRow]
    pv: int
    uv: int
    ai_rounds: int | None = None
    completed_ai_rounds: int | None = None
