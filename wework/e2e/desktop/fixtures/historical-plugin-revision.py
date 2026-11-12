"""Seed a historical same-version package revision in the isolated E2E store."""

import json
import sys
from pathlib import Path

from sqlalchemy import update

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "backend"))

from app.db.session import SessionLocal  # noqa: E402
from app.models.plugin_marketplace import PluginRelease  # noqa: E402
from app.services.official_plugin_publisher import (  # noqa: E402
    official_plugin_publisher,
)
from app.services.plugin_marketplace_service import (  # noqa: E402
    plugin_marketplace_service,
)
from app.services.plugin_package_storage import plugin_package_storage  # noqa: E402


def seed(release_id: int, source: Path) -> None:
    built = official_plugin_publisher.build_package(source)
    assert built.name == "recovery-primary"
    with SessionLocal() as db:
        release = db.get(PluginRelease, release_id)
        assert release is not None and release.status == "ready"
        assert release.manifest_json["name"] == built.name
        assert release.version == built.version and release.sha256 != built.sha256
        previous = release.sha256
        key = plugin_marketplace_service._storage_key(
            release.plugin_id, release.id, built.sha256
        )
        plugin_package_storage.put_immutable(key, built.package)
        # Current releases are immutable. Recreate an old writer's revision
        # only in test data, retaining the original immutable package object.
        result = db.execute(
            update(PluginRelease.__table__)
            .where(PluginRelease.id == release_id, PluginRelease.sha256 == previous)
            .values(storage_key=key, sha256=built.sha256, size_bytes=built.size_bytes)
        )
        assert result.rowcount == 1
        db.commit()
        print(json.dumps({"previous": previous, "checksum": built.sha256}))


if __name__ == "__main__":
    seed(int(sys.argv[1]), Path(sys.argv[2]))
