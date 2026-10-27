#!/usr/bin/env python3
"""Build and publish a WeWork-owned plugin release."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from sqlalchemy.exc import OperationalError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.session import SessionLocal  # noqa: E402
from app.services.official_plugin_publisher import (  # noqa: E402
    OfficialPluginPackage,
    official_plugin_publisher,
)
from app.services.plugin_marketplace_service import PublishedRelease  # noqa: E402

MYSQL_DEADLOCK_ERROR = 1213
PUBLISH_ATTEMPTS = 3


def _is_mysql_deadlock(error: OperationalError) -> bool:
    original = error.orig
    return bool(original.args and original.args[0] == MYSQL_DEADLOCK_ERROR)


def publish_release(
    built: OfficialPluginPackage,
    args: argparse.Namespace,
    provenance: dict[str, str],
) -> PublishedRelease:
    """Publish one release, retrying transient MySQL deadlocks.

    Parallel publishes of adjacent catalog slugs can deadlock while inserting;
    MySQL rolls the whole transaction back, so a retry starts from a clean state.
    """
    for attempt in range(1, PUBLISH_ATTEMPTS + 1):
        try:
            with SessionLocal() as db:
                return official_plugin_publisher.publish_package(
                    db,
                    built=built,
                    slug=args.slug,
                    listing_type=args.listing_type,
                    visibility=args.visibility,
                    featured_rank=args.featured_rank,
                    created_by_user_id=args.created_by_user_id,
                    provenance=provenance,
                )
        except OperationalError as exc:
            if not _is_mysql_deadlock(exc) or attempt == PUBLISH_ATTEMPTS:
                raise
            print(
                f"Retrying plugin publish after MySQL deadlock (attempt {attempt})",
                file=sys.stderr,
            )
            time.sleep(0.2 * attempt)
    raise AssertionError("unreachable")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Publish one official plugin through Marketplace V2"
    )
    parser.add_argument(
        "source", type=Path, help="Plugin source directory or prebuilt ZIP"
    )
    parser.add_argument(
        "--prebuilt", action="store_true", help="Publish the exact CI-built ZIP"
    )
    parser.add_argument(
        "--sha256", help="Required expected archive checksum with --prebuilt"
    )
    parser.add_argument("--slug", help="Catalog slug; defaults to manifest name")
    parser.add_argument("--listing-type", choices=("plugin", "skill"), default="plugin")
    parser.add_argument(
        "--visibility", choices=("workspace", "public"), default="workspace"
    )
    parser.add_argument("--featured-rank", type=int)
    parser.add_argument("--created-by-user-id", type=int)
    parser.add_argument("--commit-sha", default="")
    parser.add_argument("--build-url", default="")
    parser.add_argument("--publisher", default="ci")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Build and scan without writing MySQL or object storage",
    )
    args = parser.parse_args()

    if args.prebuilt and not args.sha256:
        parser.error("--prebuilt requires --sha256")
    if args.sha256 and not args.prebuilt:
        parser.error("--sha256 requires --prebuilt")
    built = (
        official_plugin_publisher.load_archive(args.source, expected_sha256=args.sha256)
        if args.prebuilt
        else official_plugin_publisher.build_package(args.source)
    )
    output = {
        "name": built.name,
        "version": built.version,
        "sha256": built.sha256,
        "sizeBytes": built.size_bytes,
        "dryRun": args.dry_run,
    }
    if not args.dry_run:
        provenance = {
            key: value
            for key, value in {
                "commitSha": args.commit_sha.strip(),
                "buildUrl": args.build_url.strip(),
                "publisher": args.publisher.strip(),
            }.items()
            if value
        }
        result = publish_release(built, args, provenance)
        output.update(
            {
                "pluginId": result.release.plugin_id,
                "releaseId": result.release.id,
                "created": result.created,
                "storageKey": result.release.storage_key,
            }
        )
    print(json.dumps(output, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
