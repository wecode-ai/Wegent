"""Insert the historical two-Bot Team shape without invoking current Team writers."""

import json
import os

from sqlalchemy.engine import make_url


def main() -> None:
    url = make_url(os.environ["DATABASE_URL"])
    if url.get_backend_name() != "mysql" or url.database != "wegent_test":
        raise ValueError(
            "Legacy Team fixture requires the isolated wegent_test database"
        )

    from app.db.session import SessionLocal
    from app.models.kind import Kind

    data = json.loads(os.environ["WEGENT_ISOLATED_DATABASE_REQUEST"])
    name = data["name"]
    if not name.startswith("e2e-collaboration-agents-"):
        raise ValueError("Expected an E2E-owned Team")
    with SessionLocal() as db:
        bots = [
            db.query(Kind)
            .filter_by(
                kind="Bot",
                user_id=data["owner"],
                namespace="default",
                id=bot["id"],
                name=bot["name"],
                is_active=True,
            )
            .one()
            for bot in data["bots"]
        ]
        team = Kind(
            user_id=data["owner"],
            namespace="default",
            name=name,
            kind="Team",
            is_active=True,
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Team",
                "metadata": {
                    "name": name,
                    "namespace": "default",
                    "displayName": "Review team",
                },
                "spec": {
                    "collaborationModel": "pipeline",
                    "bind_mode": ["chat"],
                    "requiresWorkspace": False,
                    "members": [
                        {
                            "botRef": {"name": bot.name, "namespace": "default"},
                            "role": "worker" if index else "leader",
                            "contextPassing": "original_and_previous",
                        }
                        for index, bot in enumerate(bots)
                    ],
                },
            },
        )
        db.add(team)
        db.commit()
        print(json.dumps({"id": team.id}))


if __name__ == "__main__":
    main()
