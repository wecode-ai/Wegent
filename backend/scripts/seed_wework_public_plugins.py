#!/usr/bin/env python3
"""Seed Wework-official (public) marketplace plugins from the public source repo.

Only plugins from github.com/wecode-ai/wework-plugins are published here with
``visibility=public`` (Wework官方 Tab). Enterprise-internal plugins from the
intranet GitLab repo are intentionally excluded; publish those separately with
``publish_official_plugin.py --visibility workspace``.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.session import SessionLocal  # noqa: E402
from app.services.official_plugin_publisher import (  # noqa: E402
    official_plugin_publisher,
)

# Keep in sync with github.com/wecode-ai/wework-plugins marketplace.json
WEWORK_PUBLIC_PLUGIN_SLUGS = (
    "dingtalk",
    "lark",
    "product-design",
    "wecom",
)

DEFAULT_SOURCE_ROOTS = (
    Path("../../wework-plugins-public/plugins"),
    Path("../wework-plugins-public/plugins"),
)


def _resolve_plugins_root(explicit: Path | None) -> Path:
    if explicit is not None:
        root = explicit.resolve()
        if not root.is_dir():
            raise SystemExit(f"Plugins source directory not found: {root}")
        return root

    env_root = os.environ.get("WEWORK_PUBLIC_PLUGINS_DIR", "").strip()
    if env_root:
        root = Path(env_root).expanduser().resolve()
        if not root.is_dir():
            raise SystemExit(f"WEWORK_PUBLIC_PLUGINS_DIR is not a directory: {root}")
        return root

    script_cwd = Path.cwd()
    for candidate in DEFAULT_SOURCE_ROOTS:
        root = (script_cwd / candidate).resolve()
        if root.is_dir():
            return root

    raise SystemExit(
        "Public wework-plugins checkout not found. Clone "
        "https://github.com/wecode-ai/wework-plugins next to Wegent as "
        "wework-plugins-public, or pass --plugins-dir / "
        "WEWORK_PUBLIC_PLUGINS_DIR pointing at its plugins/ directory."
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--plugins-dir",
        type=Path,
        help="Path to github.com/wecode-ai/wework-plugins/plugins",
    )
    parser.add_argument(
        "--created-by-user-id",
        type=int,
        default=1,
        help="Audit user id stored on new releases",
    )
    parser.add_argument(
        "--publisher",
        default="seed-wework-public",
        help="Publisher identity recorded in release provenance",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Build and scan each plugin without writing MySQL or object storage",
    )
    args = parser.parse_args()

    plugins_root = _resolve_plugins_root(args.plugins_dir)
    results: list[dict[str, object]] = []

    for index, slug in enumerate(WEWORK_PUBLIC_PLUGIN_SLUGS, start=1):
        source = plugins_root / slug
        if not source.is_dir():
            raise SystemExit(f"Missing public plugin source: {source}")
        built = official_plugin_publisher.build_package(source)
        entry: dict[str, object] = {
            "slug": slug,
            "name": built.name,
            "version": built.version,
            "sha256": built.sha256,
            "sizeBytes": built.size_bytes,
            "visibility": "public",
            "dryRun": args.dry_run,
        }
        if not args.dry_run:
            with SessionLocal() as db:
                published = official_plugin_publisher.publish_package(
                    db,
                    built=built,
                    slug=slug,
                    listing_type="plugin",
                    visibility="public",
                    featured_rank=index,
                    created_by_user_id=args.created_by_user_id,
                    provenance={"publisher": args.publisher},
                )
                entry.update(
                    {
                        "pluginId": published.release.plugin_id,
                        "releaseId": published.release.id,
                        "created": published.created,
                        "storageKey": published.release.storage_key,
                    }
                )
        results.append(entry)

    print(
        json.dumps(
            {
                "pluginsDir": str(plugins_root),
                "count": len(results),
                "items": results,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
