# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Worker-owned database phases for wizard endpoints."""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

from fastapi import HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.schemas.wizard import (
    AvailableSkill,
    CreateAllRequest,
    CreateAllResponse,
    ModelRecommendation,
    RecommendConfigRequest,
    RecommendConfigResponse,
    ShellRecommendation,
)
from app.services.chat.config import extract_and_process_model_config

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class WizardModelPlan:
    """Detached model configuration returned after the DB session closes."""

    config: Mapping[str, Any]


@dataclass(frozen=True)
class WizardSkillInfo:
    name: str
    display_name: str
    description: str
    is_public: bool


@dataclass(frozen=True)
class WizardSkillPlan:
    available_skills: tuple[AvailableSkill, ...]
    skill_info: tuple[WizardSkillInfo, ...]


class WizardDBService:
    """Run wizard SQLAlchemy work in a worker-owned session."""

    def __init__(self, session_factory: Callable[[], Session] | None = None) -> None:
        self._configured_session_factory = session_factory

    def _session_factory(self) -> Session:
        if self._configured_session_factory is not None:
            return self._configured_session_factory()
        from app.db.session import SessionLocal

        return SessionLocal()

    def resolve_model_config(
        self,
        user_id: int,
        user_name: str,
        model_name: str | None = None,
        missing_detail: str = "No available models found for testing.",
    ) -> WizardModelPlan:
        with self._session_factory() as db:
            model = self._select_model(db, user_id, model_name)
            if model is None:
                raise HTTPException(status_code=400, detail=missing_detail)
            model_spec = dict((model.json or {}).get("spec") or {})
            config = extract_and_process_model_config(
                model_spec=model_spec,
                user_id=user_id,
                user_name=user_name,
            )
            return WizardModelPlan(config=MappingProxyType(config))

    @staticmethod
    def _select_model(
        db: Session,
        user_id: int,
        model_name: str | None,
    ) -> Kind | None:
        if model_name:
            model = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Model",
                    Kind.is_active.is_(True),
                    Kind.name == model_name,
                    or_(Kind.user_id == user_id, Kind.user_id == 0),
                )
                .first()
            )
            if model is not None:
                return model
        if settings.WIZARD_MODEL_NAME:
            model = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Model",
                    Kind.name == settings.WIZARD_MODEL_NAME,
                    Kind.is_active.is_(True),
                )
                .first()
            )
            if model is not None:
                return model
        model = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Model",
                Kind.is_active.is_(True),
            )
            .first()
        )
        if model is not None:
            return model
        return (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Model",
                Kind.is_active.is_(True),
            )
            .first()
        )

    def load_skill_plan(self, user_id: int, shell_type: str) -> WizardSkillPlan:
        with self._session_factory() as db:
            rows = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Skill",
                    Kind.is_active.is_(True),
                    or_(Kind.user_id == user_id, Kind.user_id == 0),
                )
                .order_by(Kind.created_at.desc())
                .all()
            )
            available: list[AvailableSkill] = []
            info: list[WizardSkillInfo] = []
            for row in rows:
                spec = dict((row.json or {}).get("spec") or {})
                bind_shells = spec.get("bindShells")
                if bind_shells and shell_type not in bind_shells:
                    continue
                description = str(spec.get("description") or "")
                display_name = str(spec.get("displayName") or row.name)
                available.append(
                    AvailableSkill(
                        name=row.name,
                        display_name=spec.get("displayName"),
                        description=description,
                        is_public=row.user_id == 0,
                        bind_shells=bind_shells,
                    )
                )
                info.append(
                    WizardSkillInfo(
                        name=row.name,
                        display_name=display_name,
                        description=description,
                        is_public=row.user_id == 0,
                    )
                )
            return WizardSkillPlan(tuple(available), tuple(info))

    def recommend_config(
        self,
        request: RecommendConfigRequest,
        user_id: int,
    ) -> RecommendConfigResponse:
        purpose_lower = request.answers.purpose.lower()
        example_input = (
            request.answers.example_input
            or request.answers.example_task
            or request.answers.knowledge_domain
            or ""
        )
        expected_output = request.answers.expected_output or ""
        example_text_lower = (example_input + " " + expected_output).lower()
        shell_type = "Chat"
        shell_reason = "Perfect for everyday conversations and quick Q&A"
        confidence = 0.85
        code_keywords = (
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
        )
        complex_keywords = (
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
        )
        if any(
            keyword in purpose_lower or keyword in example_text_lower
            for keyword in code_keywords
        ):
            shell_type = "ClaudeCode"
            shell_reason = "Ideal for working with code and technical projects"
            confidence = 0.9
        elif any(
            keyword in purpose_lower or keyword in example_text_lower
            for keyword in complex_keywords
        ):
            shell_type = "Agno"
            shell_reason = "Great for complex tasks that need multiple steps"
            confidence = 0.85

        with self._session_factory() as db:
            shells = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Shell",
                    Kind.is_active.is_(True),
                    or_(Kind.user_id == user_id, Kind.user_id == 0),
                )
                .all()
            )
            shell_name = shell_type.lower()
            for shell in shells:
                spec = dict((shell.json or {}).get("spec") or {})
                if spec.get("shellType") == shell_type:
                    shell_name = shell.name
                    break
            models = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Model",
                    Kind.is_active.is_(True),
                    or_(Kind.user_id == user_id, Kind.user_id == 0),
                )
                .all()
            )
            model_recommendation = self._recommend_model(models, shell_type)

        alternative_shells = [
            ShellRecommendation(
                shell_name=alternative.lower(),
                shell_type=alternative,
                reason=reason,
                confidence=0.5,
            )
            for alternative, reason in (
                ("Chat", "Simple and fast conversations"),
                ("ClaudeCode", "For coding and technical work"),
                ("Agno", "For complex multi-step tasks"),
            )
            if alternative != shell_type
        ]
        return RecommendConfigResponse(
            shell=ShellRecommendation(
                shell_name=shell_name,
                shell_type=shell_type,
                reason=shell_reason,
                confidence=confidence,
            ),
            model=model_recommendation,
            alternative_shells=alternative_shells,
            alternative_models=[],
        )

    @staticmethod
    def _recommend_model(
        models: list[Kind],
        shell_type: str,
    ) -> ModelRecommendation | None:
        for model in models:
            spec = dict((model.json or {}).get("spec") or {})
            protocol = spec.get("protocol", "openai")
            if shell_type == "ClaudeCode" and protocol == "anthropic":
                return ModelRecommendation(
                    model_name=model.name,
                    model_id=spec.get("modelConfig", {}).get("modelId"),
                    reason="Recommended for this type of work",
                    confidence=0.9,
                )
            if shell_type == "Agno" and protocol == "openai":
                return ModelRecommendation(
                    model_name=model.name,
                    model_id=spec.get("modelConfig", {}).get("modelId"),
                    reason="Works great for complex tasks",
                    confidence=0.85,
                )
        if not models:
            return None
        model = models[0]
        spec = dict((model.json or {}).get("spec") or {})
        return ModelRecommendation(
            model_name=model.name,
            model_id=spec.get("modelConfig", {}).get("modelId"),
            reason="Ready to use",
            confidence=0.7,
        )

    def create_all(
        self,
        request: CreateAllRequest,
        user_id: int,
    ) -> CreateAllResponse:
        db = self._session_factory()
        try:
            ghost_name = f"{request.name}-ghost"
            ghost = Kind(
                user_id=user_id,
                kind="Ghost",
                name=ghost_name,
                namespace=request.namespace,
                json={
                    "kind": "Ghost",
                    "apiVersion": "agent.wecode.io/v1",
                    "metadata": {
                        "name": ghost_name,
                        "namespace": request.namespace,
                    },
                    "spec": {
                        "systemPrompt": request.system_prompt,
                        "mcpServers": {},
                        "skills": request.skills or [],
                    },
                },
                is_active=True,
            )
            db.add(ghost)
            db.flush()
            shell = self._find_shell(db, request, user_id)
            if shell is None:
                raise HTTPException(
                    status_code=400,
                    detail=f"Shell '{request.shell_name}' not found",
                )
            bot_name = f"{request.name}-bot"
            bot_spec: dict[str, Any] = {
                "ghostRef": {
                    "name": ghost_name,
                    "namespace": request.namespace,
                },
                "shellRef": {
                    "name": shell.name,
                    "namespace": shell.namespace,
                },
            }
            if request.model_name:
                model = (
                    db.query(Kind)
                    .filter(
                        Kind.kind == "Model",
                        Kind.is_active.is_(True),
                        Kind.name == request.model_name,
                        or_(Kind.user_id == user_id, Kind.user_id == 0),
                    )
                    .first()
                )
                if model is not None:
                    bot_spec["modelRef"] = {
                        "name": request.model_name,
                        "namespace": model.namespace,
                    }
            bot = Kind(
                user_id=user_id,
                kind="Bot",
                name=bot_name,
                namespace=request.namespace,
                json={
                    "kind": "Bot",
                    "apiVersion": "agent.wecode.io/v1",
                    "metadata": {
                        "name": bot_name,
                        "namespace": request.namespace,
                    },
                    "spec": bot_spec,
                },
                is_active=True,
            )
            db.add(bot)
            db.flush()
            team = Kind(
                user_id=user_id,
                kind="Team",
                name=request.name,
                namespace=request.namespace,
                json={
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
                },
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
        except Exception as exc:
            db.rollback()
            logger.error("Failed to create resources: %s", exc)
            raise HTTPException(
                status_code=500,
                detail=f"Failed to create agent: {exc}",
            ) from exc
        finally:
            db.close()

    @staticmethod
    def _find_shell(
        db: Session,
        request: CreateAllRequest,
        user_id: int,
    ) -> Kind | None:
        shell = (
            db.query(Kind)
            .filter(
                Kind.kind == "Shell",
                Kind.is_active.is_(True),
                or_(Kind.user_id == user_id, Kind.user_id == 0),
                Kind.name == request.shell_name,
            )
            .first()
        )
        if shell is not None:
            return shell
        shells = (
            db.query(Kind)
            .filter(
                Kind.kind == "Shell",
                Kind.is_active.is_(True),
                or_(Kind.user_id == user_id, Kind.user_id == 0),
            )
            .all()
        )
        for candidate in shells:
            spec = dict((candidate.json or {}).get("spec") or {})
            if spec.get("shellType") == request.shell_type:
                return candidate
        return None


wizard_db_service = WizardDBService()
