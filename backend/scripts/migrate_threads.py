"""Apply an explicit reviewed report; never infer a target roster or project choice."""

import argparse
import json
import os
import sys
from dataclasses import asdict
from pathlib import Path
from tempfile import NamedTemporaryFile


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory-file", type=Path, required=True)
    parser.add_argument("--receipts-file", type=Path, required=True)
    parser.add_argument("--actor-user", type=int, required=True)
    project = parser.add_mutually_exclusive_group(required=True)
    project.add_argument("--retain-source-project", dest="retain", action="store_true")
    project.add_argument("--unclassified", dest="retain", action="store_false")
    return parser.parse_args()


def save_receipts(path: Path, value: dict[str, object]) -> None:
    """Persist receipts before the ownership commit so a restart can replay it."""
    temporary = None
    try:
        with NamedTemporaryFile(
            mode="w", dir=path.parent, prefix=".thread-migration-", delete=False
        ) as output:
            temporary = Path(output.name)
            os.fchmod(output.fileno(), 0o600)
            json.dump(value, output, ensure_ascii=False, indent=2)
            output.flush()
            os.fsync(output.fileno())
        # A competing operator's receipt must never be overwritten.
        os.link(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main() -> None:
    options = parse_arguments()
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from app.db.session import get_db_session
    from app.services.thread_migration import apply_thread_migration
    from app.services.thread_migration_assets import (
        ThreadMigrationAssets,
        ThreadMigrationObjectCopy,
        prepare_thread_migration_assets,
    )
    from app.services.thread_migration_inventory import ThreadMigrationInventory

    inventory = ThreadMigrationInventory.from_dict(
        json.loads(options.inventory_file.read_text())
    )
    arguments = {
        "inventory": inventory,
        "actor_user_id": options.actor_user,
        "session_factory": get_db_session,
    }
    if options.receipts_file.exists():
        recorded = json.loads(options.receipts_file.read_text())
        assets = ThreadMigrationAssets(
            inventory_id=recorded["inventory_id"],
            objects=tuple(
                ThreadMigrationObjectCopy(**row) for row in recorded["objects"]
            ),
        )
    else:
        assets = prepare_thread_migration_assets(**arguments)
        save_receipts(options.receipts_file, asdict(assets))
    result = apply_thread_migration(
        **arguments, assets=assets, retain_source_project=options.retain
    )
    print(json.dumps(asdict(result), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
