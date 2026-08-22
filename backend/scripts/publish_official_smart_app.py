#!/usr/bin/env python3
"""Build and publish one official Wework Smart app release."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.session import SessionLocal  # noqa: E402
from app.services.official_smart_app_publisher import (  # noqa: E402
    official_smart_app_publisher,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Publish an official Smart app")
    parser.add_argument("source", type=Path)
    parser.add_argument("--featured-rank", type=int, default=0)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    built = official_smart_app_publisher.build_package(args.source)
    output = {
        "name": built.name,
        "version": built.version,
        "sha256": built.sha256,
        "sizeBytes": len(built.package),
        "dryRun": args.dry_run,
    }
    if not args.dry_run:
        with SessionLocal() as db:
            app, release, created = official_smart_app_publisher.publish_package(
                db, built=built, featured_rank=args.featured_rank
            )
            output.update(
                {"smartAppId": app.id, "releaseId": release.id, "created": created}
            )
    print(json.dumps(output, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
