"""Seed real downloadable Skills and MCP installations in isolated E2E MySQL."""

import hashlib
import io
import json
import os
from zipfile import ZipFile

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.skill_binary import SkillBinary


def main() -> None:
    url = make_url(os.environ["WEWORK_E2E_DATABASE_URL"])
    if url.host != "127.0.0.1" or not (url.database or "").startswith("wework_e2e_"):
        raise ValueError("Capability fixtures require isolated E2E MySQL")
    generation = os.environ["WEWORK_E2E_CAPABILITY_GENERATION"]
    if generation not in {"old", "new"}:
        raise ValueError("Unknown capability generation")
    name = f"registration-coordination-{generation}"
    archive = io.BytesIO()
    with ZipFile(archive, "w") as package:
        package.writestr(
            f"{name}/SKILL.md",
            f"---\nname: {name}\ndescription: Real reconnect regression\n---\n\n{name}\n",
        )
    content = archive.getvalue()
    digest = hashlib.sha256(content).hexdigest()
    engine = create_engine(url)
    try:
        with Session(engine) as db, db.begin():
            skill = Kind(
                user_id=1,
                kind="Skill",
                namespace="default",
                name=name,
                json={
                    "metadata": {"name": name, "namespace": "default"},
                    "spec": {"description": name},
                    "status": {"fileHash": digest},
                },
                is_active=True,
            )
            db.add(skill)
            db.flush()
            db.add(
                SkillBinary(
                    kind_id=skill.id,
                    binary_data=content,
                    file_size=len(content),
                    file_hash=digest,
                )
            )
            installed_skill = Kind(
                user_id=1,
                kind="InstalledSkill",
                namespace="default",
                name=name,
                json={
                    "spec": {
                        "skillRef": {
                            "kind": "Skill",
                            "name": name,
                            "namespace": "default",
                            "user_id": 1,
                        },
                        "source": {
                            "type": "system",
                            "providerKey": "builtin",
                            "skillKey": name,
                        },
                        "enabled": True,
                        "installState": "installed",
                    }
                },
                is_active=True,
            )
            mcp = Kind(
                user_id=1,
                kind="InstalledMCP",
                namespace="default",
                name=name,
                json={
                    "spec": {
                        "source": {"type": "custom", "serverKey": name},
                        "server": {
                            "type": "stdio",
                            "command": "node",
                            "args": ["--version"],
                        },
                        "enabled": True,
                        "installState": "installed",
                    }
                },
                is_active=True,
            )
            db.add_all([installed_skill, mcp])
            db.flush()
            result = {
                "name": name,
                "skillId": skill.id,
                "installedSkillId": installed_skill.id,
                "mcpId": mcp.id,
            }
        print(json.dumps(result))
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
