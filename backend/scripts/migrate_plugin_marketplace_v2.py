#!/usr/bin/env python3
"""Migrate the legacy Kind-based plugin marketplace to Marketplace V2."""

import argparse

from app.db.session import SessionLocal
from app.services.plugin_marketplace_migration_service import (
    plugin_marketplace_migration_service,
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--retire-legacy",
        action="store_true",
        help="Deactivate legacy catalog Kinds and remove their copied blobs",
    )
    args = parser.parse_args()
    with SessionLocal() as db:
        result = plugin_marketplace_migration_service.migrate(
            db, retire_legacy=args.retire_legacy
        )
    print(
        "Marketplace V2 migration completed: "
        f"plugins={result.migrated_plugins}, "
        f"installations={result.migrated_installations}, skipped={result.skipped}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
