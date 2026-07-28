#!/usr/bin/env python3
"""Configure the curated OpenAI GitHub plugin as a synchronized mirror."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.session import SessionLocal  # noqa: E402
from app.services.plugin_marketplace_service import (  # noqa: E402
    plugin_marketplace_service,
)
from app.services.plugin_upstream_adapter import (  # noqa: E402
    OPENAI_GITHUB_MARKETPLACE,
    OPENAI_GITHUB_REMOTE_PLUGIN_ID,
)

DEFAULT_UPSTREAM_URL = "https://github.com/openai/plugins/archive/refs/heads/main.zip"
DEFAULT_LICENSE_INFO = "OpenAI plugins repository; bundled plugin licenses apply"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream-url", default=DEFAULT_UPSTREAM_URL)
    parser.add_argument("--license-info", default=DEFAULT_LICENSE_INFO)
    args = parser.parse_args()

    with SessionLocal() as db:
        upstream = plugin_marketplace_service.configure_existing_upstream(
            db,
            slug=OPENAI_GITHUB_REMOTE_PLUGIN_ID,
            marketplace_name=OPENAI_GITHUB_MARKETPLACE,
            remote_plugin_id=OPENAI_GITHUB_REMOTE_PLUGIN_ID,
            upstream_url=args.upstream_url,
            license_info=args.license_info,
            sync_policy="review_required",
        )
    print(
        json.dumps(
            {
                "pluginId": upstream.pluginId,
                "upstreamId": upstream.id,
                "sourceType": "mirror",
                "sourceProvider": "codex",
                "syncEnabled": upstream.syncEnabled,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
