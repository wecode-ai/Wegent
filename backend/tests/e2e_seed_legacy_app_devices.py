"""Seed historical duplicates for the CI-covered app identity browser scenario."""

import copy
import json
import os
import sys

from sqlalchemy.engine import make_url


def main() -> None:
    # Never fall back to the developer's .env database for a test fixture.
    url = make_url(os.environ["DATABASE_URL"])
    if url.get_backend_name() != "sqlite" and url.database != "wegent_test":
        raise RuntimeError(
            "Legacy fixture requires SQLite or the isolated wegent_test database"
        )
    from app.db.session import SessionLocal
    from app.models.kind import Kind
    from app.models.user import User

    data = json.load(sys.stdin)
    with SessionLocal() as db:
        user = db.query(User).filter_by(id=data["user_id"]).one()
        assert user.user_name.startswith("e2e-app-identity-")
        original = (
            db.query(Kind)
            .filter_by(
                id=data["record_id"],
                user_id=user.id,
                namespace="default",
                kind="Device",
                name=data["device_id"],
                is_active=True,
            )
            .one()
        )
        rows = []
        for suffix in [None, data["other_suffix"]]:
            resource = copy.deepcopy(original.json)
            if suffix:
                resource["spec"]["runtimeInstanceId"] = f"runtime-{suffix}"
                resource["spec"]["appDeviceId"] = f"electron-{suffix}"
            row = Kind(
                user_id=user.id,
                namespace="default",
                kind="Device",
                name=original.name,
                is_active=True,
                json=resource,
            )
            db.add(row)
            rows.append(row)
        db.commit()
        print(json.dumps({"duplicate_id": rows[0].id, "other_id": rows[1].id}))


if __name__ == "__main__":
    main()
