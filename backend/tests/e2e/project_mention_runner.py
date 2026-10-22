"""Arrange an assigned robot with unavailable runners for mention regression."""

import argparse
import os

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.delivery import LoopItem, ProjectChatAgent
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage


def manage_runner(db: Session, item_id: str, action: str) -> None:
    item = db.get(LoopItem, item_id)
    if item is None:
        raise ValueError("Expected the mention E2E Issue")
    agent_id = f"mention-e2e-{item_id}"
    agent = db.get(ProjectChatAgent, agent_id)
    if action == "seed":
        if agent is not None or item.assignee_agent_id:
            raise ValueError("Expected an unassigned mention E2E Issue")
        db.add(
            ProjectChatAgent(
                id=agent_id,
                cloud_project_id=item.cloud_project_id,
                name="Unavailable mention runner",
                status="active",
                created_by_user_id=item.created_by_user_id,
                metadata_json={
                    "runtime": "codex",
                    "execution_policy": {"mode": "project_pool"},
                    "model_policy": {
                        "mode": "fixed",
                        "model": {
                            "runtime": "codex",
                            "provider": "openai",
                            "model_id": "unavailable-mention-model",
                        },
                    },
                },
            )
        )
        item.assignee_agent_id = agent_id
    elif agent is None or agent.cloud_project_id != item.cloud_project_id:
        raise ValueError("Expected the seeded mention E2E robot")
    elif action == "check":
        if item.assignee_agent_id != agent_id:
            raise ValueError("Mention changed the Issue assignee")
        if db.query(LoopItemExecution).filter_by(loop_item_id=item_id).count():
            raise ValueError("Member mention created an execution")
        if (
            db.query(ProjectChatMessage)
            .filter_by(task_id=item_id, sender_type="agent")
            .count()
        ):
            raise ValueError("Member mention created an AI response")
    elif action == "check-agent":
        if item.assignee_agent_id != agent_id:
            raise ValueError("Agent mention changed the Issue assignee")
        execution = db.query(LoopItemExecution).filter_by(loop_item_id=item_id).one()
        if execution.agent_id != agent_id or execution.status != "failed":
            raise ValueError("Unavailable agent must have one failed execution")
        messages = db.query(ProjectChatMessage).filter_by(task_id=item_id).all()
        comments = [message for message in messages if message.sender_type == "user"]
        responses = [message for message in messages if message.sender_type == "agent"]
        if len(comments) != 1 or comments[0].status != "completed":
            raise ValueError("Agent mention must preserve the saved comment")
        if len(responses) != 1 or responses[0].status != "failed":
            raise ValueError("Execution failure must be projected to one AI activity")
    elif action == "cleanup":
        item.assignee_agent_id = ""
        db.delete(agent)
    db.commit()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["seed", "check", "check-agent", "cleanup"])
    parser.add_argument("item_id")
    args = parser.parse_args()
    if not os.environ.get("DATABASE_URL"):
        parser.error("DATABASE_URL must explicitly select the running E2E database")
    with SessionLocal() as db:
        manage_runner(db, args.item_id, args.action)
