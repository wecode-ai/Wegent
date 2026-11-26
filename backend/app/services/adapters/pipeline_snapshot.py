# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Persist only non-secret Pipeline inputs in the Task admission transaction."""

from typing import Any

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.task import TaskResource, TaskTeamStrategy
from app.services.execution_permission_scope import execution_resource_scope
from app.services.readers import KindType, kindReader


@execution_resource_scope()
def save_pipeline_snapshot(db: Session, task: TaskResource, team: Kind) -> None:
    spec = team.json["spec"]
    if spec.get("collaborationModel") != "pipeline":
        return
    members = spec["members"]
    definitions = {}
    refs = {
        (m["botRef"].get("namespace", "default"), m["botRef"]["name"]) for m in members
    }
    labels = task.json.get("metadata", {}).get("labels") or {}
    override = labels.get("modelId")
    force_override = str(labels.get("forceOverrideBotModel", "")).lower() == "true"
    for namespace, name in refs:
        bot_id, definition = _bot_definition(
            db, team.user_id, task.user_id, namespace, name, override, force_override
        )
        definitions[str(bot_id)] = definition
    task.json = {
        **task.json,
        "spec": {
            **task.json["spec"],
            "currentStage": 0,
            "teamRef": {**task.json["spec"]["teamRef"], "user_id": team.user_id},
        },
    }
    if task.id is None:
        db.flush()
    db.add(
        TaskTeamStrategy(
            task_id=task.id,
            strategy={
                "collaborationModel": "pipeline",
                "team_ref": task.json["spec"]["teamRef"],
                "members": members,
                "bots": definitions,
            },
        )
    )


def _bot_definition(
    db: Session,
    owner: int,
    user_id: int,
    namespace: str,
    name: str,
    override: str | None,
    force_override: bool,
) -> tuple[int, dict]:
    from app.services.chat.config.model_lookup import _resolve_model_for_bot

    bot = kindReader.get_by_name_and_namespace(db, owner, KindType.BOT, namespace, name)
    if not bot:
        raise ValueError(f"Team member Bot '{namespace}/{name}' is unavailable")
    bot_spec = bot.json["spec"]
    ghost_ref = bot_spec["ghostRef"]
    ghost = kindReader.get_by_name_and_namespace(
        db,
        owner,
        KindType.GHOST,
        ghost_ref.get("namespace", "default"),
        ghost_ref["name"],
    )
    if not ghost:
        raise ValueError(f"Ghost for '{namespace}/{name}' is unavailable")
    definition: dict[str, Any] = {
        "ghost_prompt": ghost.json["spec"].get("systemPrompt") or ""
    }
    if bot_spec.get("execution_policy") is None:
        model, model_spec, model_name, config = _resolve_model_for_bot(
            db, bot, user_id, override, force_override
        )
        model_env = (model_spec or {}).get("modelConfig", {}).get("env")
        if not model_env:
            raise ValueError(f"Model for '{namespace}/{name}' is unavailable")
        definition.update(
            model_resource_id=model.id if model else None,
            model_name=model_name,
            model_id=model_env.get("model_id", "gpt-4"),
        )
        env = config.get("env") or {}
        if (
            not (force_override and override)
            and env.get("model")
            and env.get("api_key")
        ):
            definition["inline_env"] = {
                k: env[k] for k in ("model", "model_id") if isinstance(env.get(k), str)
            }
    return bot.id, definition


def accepted_team(db: Session, task_id: int, team: Kind) -> Kind:
    saved = db.get(TaskTeamStrategy, task_id)
    if saved is None:
        return team
    return overlay_team(team, saved.strategy)


def overlay_team(team: Kind, strategy: dict) -> Kind:
    ref = strategy.get("team_ref")
    if ref and (ref["name"], ref.get("namespace", "default"), ref.get("user_id")) != (
        team.name,
        team.namespace,
        team.user_id,
    ):
        raise ValueError("Pipeline Team binding changed")
    spec = {
        **team.json["spec"],
        **{key: strategy[key] for key in ("members", "collaborationModel")},
    }
    return Kind(
        id=team.id,
        name=team.name,
        namespace=team.namespace,
        user_id=team.user_id,
        kind=team.kind,
        json={**team.json, "spec": spec},
        is_active=team.is_active,
    )
