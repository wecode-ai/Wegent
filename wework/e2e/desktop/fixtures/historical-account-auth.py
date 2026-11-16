"""Seed historical auth snapshots in the isolated desktop E2E database."""

import json
import sys
from copy import deepcopy
from pathlib import Path

from sqlalchemy import update

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "backend"))

from app.db.session import SessionLocal  # noqa: E402
from app.models.kind import Kind  # noqa: E402
from app.models.plugin_marketplace import PluginRelease  # noqa: E402


def seed(mode: str, row_id: int) -> None:
    with SessionLocal() as db:
        model = PluginRelease if mode == "scan" else Kind
        row = db.get(model, row_id)
        assert row is not None
        if mode == "scan":
            assert row.manifest_json["name"] == "desktop-account-auth"
            payload = deepcopy(row.scan_report_json)
            components = payload["components"]
        else:
            assert row.kind == "InstalledPlugin"
            assert row.json["spec"]["source"]["pluginKey"] == "desktop-account-auth"
            payload = deepcopy(row.json)
            components = payload["spec"]["components"]
        removed = 0
        for connector in components["connectors"]:
            if connector.pop("accountAuth", None) is not None:
                removed += 1
        assert removed > 0
        column = "scan_report_json" if mode == "scan" else "json"
        # Deliberately recreate an old writer's snapshot. The production ORM
        # correctly forbids changing ready releases; no package is modified.
        db.execute(
            update(model.__table__).where(model.id == row_id).values({column: payload})
        )
        db.commit()
        print(json.dumps({"removed": removed}))


if __name__ == "__main__":
    assert sys.argv[1] in {"scan", "installed"}
    seed(sys.argv[1], int(sys.argv[2]))
