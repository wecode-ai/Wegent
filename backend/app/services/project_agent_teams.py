"""Persist native project Agents as project-owned execution definitions.

A project-only Agent keeps its existing authorization and its device settings.
Its private execution definition grants no catalog or workspace use rights.
"""

from sqlalchemy import select
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Session

from app.models.delivery import LoopNode, ProjectChatAgent
from app.models.kind import Kind


def write_project_agent_team(connection: Connection, agent: ProjectChatAgent) -> dict:
    metadata, _ = _project_agent_binding(connection, agent)
    return metadata


def _project_agent_binding(
    connection: Connection,
    agent: ProjectChatAgent,
    *,
    backfill: bool = False,
    rollback: bool = False,
) -> tuple[dict, bool]:
    metadata = dict(agent.metadata_json or {})
    runtime = metadata.get("runtime")
    owner = agent.created_by_user_id
    if not owner or owner < 0 or not agent.cloud_project_id:
        return metadata, False
    namespace = f"projects/{agent.cloud_project_id}"
    name = f"agent-{agent.id}"
    if (
        runtime not in {"codex", "claude_code"}
        or metadata.get("wegent_team_id") is not None
    ):
        if backfill:
            return metadata, False
        if metadata.pop("teamRef", None) is not None:
            kinds = Kind.__table__
            connection.execute(
                kinds.update()
                .where(
                    kinds.c.user_id == owner,
                    kinds.c.namespace == namespace,
                    kinds.c.name == name,
                    kinds.c.json["metadata"]["migrationSource"].as_string() == agent.id,
                )
                .values(is_active=False)
            )
        return metadata, False
    if rollback and "teamRef" not in metadata:
        return metadata, False
    ref = {"name": name, "namespace": namespace}
    skills = metadata.get("additional_skills") or []
    specs = {
        "Ghost": {
            "systemPrompt": metadata.get("system_prompt", ""),
            "plugins": metadata.get("plugins", []),
            "mcpServers": metadata.get("mcp_servers", {}),
            "skills": [
                skill["name"]
                for skill in skills
                if isinstance(skill, dict)
                and isinstance(skill.get("name"), str)
                and skill["name"]
            ],
        },
        "Shell": {
            "shellType": {"codex": "Codex", "claude_code": "ClaudeCode"}[runtime]
        },
        "Bot": {
            "ghostRef": ref,
            "shellRef": ref,
            **{
                key: metadata[key]
                for key in ("execution_policy", "model_policy", "capability_mode")
                if metadata.get(key) is not None
            },
        },
        "Team": {"members": [{"botRef": ref}], "collaborationModel": "solo"},
    }
    kinds = Kind.__table__
    existing = {}
    for row in connection.execute(
        select(kinds.c.id, kinds.c.kind, kinds.c.json, kinds.c.is_active)
        .where(
            kinds.c.user_id == owner,
            kinds.c.namespace == namespace,
            kinds.c.name == name,
            kinds.c.kind.in_(specs),
        )
        .with_for_update()
    ):
        if (
            row.kind in existing
            or row.json.get("metadata", {}).get("migrationSource") != agent.id
        ):
            raise ValueError(
                f"Project Agent {agent.id} conflicts with an existing resource"
            )
        existing[row.kind] = row
    previous_id = metadata.get("teamRef")
    if "teamRef" in metadata and (
        type(previous_id) is not int
        or "Team" not in existing
        or existing["Team"].id != previous_id
    ):
        raise ValueError(
            f"Project Agent {agent.id} Team binding does not match its source"
        )
    if rollback:
        metadata.pop("teamRef")
        return metadata, False
    active = agent.status != "archived"
    for kind, spec in specs.items():
        definition = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": kind,
            "metadata": {
                **ref,
                "displayName": agent.title or agent.name,
                "migrationSource": agent.id,
            },
            "spec": spec,
        }
        row = existing.get(kind)
        if row is None:
            key = connection.execute(
                kinds.insert().values(
                    kind=kind,
                    name=name,
                    namespace=namespace,
                    user_id=owner,
                    json=definition,
                    is_active=active,
                )
            ).inserted_primary_key[0]
        else:
            key = row.id
            if not backfill and (row.json != definition or row.is_active != active):
                connection.execute(
                    kinds.update()
                    .where(kinds.c.id == key)
                    .values(json=definition, is_active=active)
                )
        if kind == "Team":
            metadata["teamRef"] = key
    return metadata, "Team" not in existing


def project_team_config(db, agent: ProjectChatAgent, config: dict) -> dict:
    """Compile from the persisted project-local definition under its original grant."""
    namespace = f"projects/{agent.cloud_project_id}"
    name = f"agent-{agent.id}"
    rows = (
        db.query(Kind)
        .filter_by(
            user_id=agent.created_by_user_id,
            namespace=namespace,
            name=name,
            is_active=True,
        )
        .filter(Kind.kind.in_(("Team", "Bot", "Shell", "Ghost")))
        .all()
    )
    definitions = {row.kind: row for row in rows}
    ref = {"name": name, "namespace": namespace}
    previous_id = (agent.metadata_json or {}).get("teamRef")
    if (
        type(previous_id) is not int
        or len(rows) != 4
        or set(definitions) != {"Team", "Bot", "Shell", "Ghost"}
        or any(
            row.json["metadata"].get("migrationSource") != agent.id
            for row in definitions.values()
        )
        or definitions["Team"].id != previous_id
    ):
        raise ValueError("Project Agent has no valid persisted Team binding")
    spec = definitions["Team"].json["spec"]
    bot = definitions["Bot"].json["spec"]
    if (
        spec["members"] != [{"botRef": ref}]
        or bot["ghostRef"] != ref
        or bot["shellRef"] != ref
    ):
        raise ValueError("Project Agent Team dependency mismatch")
    ghost = definitions["Ghost"].json["spec"]
    return {
        **config,
        "teamRef": definitions["Team"].id,
        "runtime": {"Codex": "codex", "ClaudeCode": "claude_code"}[
            definitions["Shell"].json["spec"]["shellType"]
        ],
        "system_prompt": ghost["systemPrompt"],
        "mcp_servers": ghost["mcpServers"],
        "plugins": ghost["plugins"],
    }


def migrate(
    db: Session,
    *,
    batch_size: int = 100,
    rollback: bool = False,
    commit_batches: bool = True,
) -> dict[str, int]:
    from app.models.loop_item_execution import LoopItemExecution
    from app.services.loop_item_executions.service import ACTIVE_STATUSES

    if rollback:
        from app.models.delivery import LoopItem
        from app.models.project_chat_message import ProjectChatMessage

        metadata = ProjectChatMessage.metadata_json
        pending = (
            db.query(ProjectChatMessage.id)
            .join(LoopItem, LoopItem.id == metadata["issue_id"].as_string())
            .filter(
                ProjectChatMessage.message_type == "coordination",
                ProjectChatMessage.status == "active",
                metadata["protocol"].as_integer() == 2,
                LoopItem.cloud_project_id == metadata["project_id"].as_string(),
                LoopItem.metadata_json["collaboration_group_assignment_key"].as_string()
                == metadata["assignment_key"].as_string(),
            )
            .first()
        )
        from sqlalchemy import JSON, case, func, type_coerce

        payload = type_coerce(
            case(
                (
                    func.json_valid(LoopItemExecution.execution_payload) == 1,
                    LoopItemExecution.execution_payload,
                ),
                else_="{}",
            ),
            JSON,
        )
        running = (
            db.query(LoopItemExecution.id)
            .filter(
                LoopItemExecution.status.in_(ACTIVE_STATUSES),
                payload["origin_context"]["dispatch_protocol_version"].as_integer()
                == 2,
            )
            .first()
        )
        if pending or running:
            raise ValueError("Finish active v2 Issue coordination before downgrading")

    counts = {
        "created": 0,
        "reused": 0,
        "unavailable": 0,
        "detached": 0,
        "invalid_references": 0,
        "unfinished_executions": db.query(LoopItemExecution)
        .filter(LoopItemExecution.status.in_(ACTIVE_STATUSES))
        .count(),
    }
    cursor = ""
    nodes = LoopNode.__table__
    while True:
        rows = (
            db.query(ProjectChatAgent)
            .filter(ProjectChatAgent.id > cursor)
            .order_by(ProjectChatAgent.id)
            .limit(batch_size)
            .populate_existing()
            .with_for_update()
            .all()
        )
        if not rows:
            return counts
        cursor = rows[-1].id
        for row in rows:
            previous = row.metadata_json or {}
            metadata, created = _project_agent_binding(
                db.connection(), row, backfill=True, rollback=rollback
            )
            if previous != metadata:
                db.execute(
                    nodes.update().where(nodes.c.id == row.id).values(metadata=metadata)
                )
            if rollback and previous != metadata:
                counts["detached"] += 1
            elif created:
                counts["created"] += 1
            elif metadata.get("wegent_team_id") is not None:
                key = metadata["wegent_team_id"]
                team = db.get(Kind, key) if type(key) is int and key > 0 else None
                if team is None or team.kind != "Team" or not team.is_active:
                    counts["invalid_references"] += 1
                else:
                    counts["reused"] += 1
            elif metadata.get("teamRef"):
                counts["reused"] += 1
            else:
                counts["unavailable"] += 1
        if commit_batches:
            db.commit()
