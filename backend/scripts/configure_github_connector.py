#!/usr/bin/env python3
"""Create or update the system GitHub OAuth connector."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.session import SessionLocal  # noqa: E402
from app.models.user import User  # noqa: E402
from app.schemas.connector import ConnectorAppUpdate, ConnectorAppWrite  # noqa: E402
from app.services.connector_apps import connector_app_service  # noqa: E402

GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--admin-user-id", type=int, required=True)
    parser.add_argument("--disabled", action="store_true")
    args = parser.parse_args()
    with SessionLocal() as db:
        admin = db.get(User, args.admin_user_id)
        if not admin or admin.role != "admin":
            raise SystemExit("--admin-user-id must identify an administrator")
        existing = connector_app_service.get_app_by_slug(db, "github")
        if existing:
            app = connector_app_service.update_app(
                db,
                existing,
                ConnectorAppUpdate(
                    name="GitHub",
                    description="GitHub repositories, issues, pull requests, and Actions",
                    enabled=not args.disabled,
                    visibility="all",
                    allowed_roles=[],
                    auth_type="oauth2",
                    transport="streamable-http",
                    mcp_url=GITHUB_MCP_URL,
                    forward_user_context_headers=False,
                    tool_allowlist=[],
                    http_tools=[],
                ),
            )
        else:
            app = connector_app_service.create_app(
                db,
                ConnectorAppWrite(
                    slug="github",
                    name="GitHub",
                    description=(
                        "GitHub repositories, issues, pull requests, and Actions"
                    ),
                    enabled=not args.disabled,
                    visibility="all",
                    allowed_roles=[],
                    auth_type="oauth2",
                    transport="streamable-http",
                    mcp_url=GITHUB_MCP_URL,
                    forward_user_context_headers=False,
                ),
                admin,
            )
    print(f"configured connector {app.slug} ({app.id})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
