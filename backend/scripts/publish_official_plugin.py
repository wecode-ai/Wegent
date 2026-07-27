#!/usr/bin/env python3
"""Build and publish a Wegent-owned plugin release."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.session import SessionLocal  # noqa: E402
from app.services.official_plugin_publisher import (  # noqa: E402
    official_plugin_publisher,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Publish one official plugin through Marketplace V2"
    )
    parser.add_argument("source", type=Path, help="Plugin source directory")
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
    parser.add_argument("--upstream-repository", default="")
    parser.add_argument("--upstream-commit", default="")
    parser.add_argument("--upstream-version", default="")
    parser.add_argument("--adapter-version", default="")
    parser.add_argument("--source-type", choices=("native", "mirror"), default="native")
    parser.add_argument(
        "--source-provider", choices=("wegent", "codex"), default="wegent"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Build and scan without writing MySQL or object storage",
    )
    args = parser.parse_args()

    built = official_plugin_publisher.build_package(args.source)
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
                "upstreamRepository": args.upstream_repository.strip(),
                "upstreamCommit": args.upstream_commit.strip(),
                "upstreamVersion": args.upstream_version.strip(),
                "adapterVersion": args.adapter_version.strip(),
            }.items()
            if value
        }
        with SessionLocal() as db:
            result = official_plugin_publisher.publish_package(
                db,
                built=built,
                slug=args.slug,
                listing_type=args.listing_type,
                visibility=args.visibility,
                featured_rank=args.featured_rank,
                created_by_user_id=args.created_by_user_id,
                provenance=provenance,
                source_type=args.source_type,
                source_provider=args.source_provider,
            )
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
