#!/usr/bin/env python3
"""Clean up existing plugins before re-publishing."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db.session import SessionLocal
from app.models.plugin_marketplace import (
    Plugin,
    PluginDeviceInstallation,
    PluginRelease,
)


def clean_plugin(slug: str) -> None:
    """Remove a plugin and all its related data."""
    with SessionLocal() as db:
        plugin = db.query(Plugin).filter(Plugin.slug == slug).first()
        if not plugin:
            print(f"Plugin '{slug}' not found, nothing to clean.")
            return

        print(f"Found plugin: {plugin.name} (ID: {plugin.id})")

        # Delete releases
        releases = (
            db.query(PluginRelease).filter(PluginRelease.plugin_id == plugin.id).all()
        )
        print(f"Deleting {len(releases)} releases...")
        for release in releases:
            db.delete(release)

        # Delete device installations
        # Note: This requires checking the kinds table for installed_kind_id
        installations = (
            db.query(PluginDeviceInstallation)
            .filter(
                PluginDeviceInstallation.installed_kind_id.in_(
                    db.query(PluginDeviceInstallation.installed_kind_id)
                    .filter(PluginDeviceInstallation.installed_kind_id != None)
                    .distinct()
                )
            )
            .all()
        )
        print(f"Deleting {len(installations)} device installations...")
        for installation in installations:
            db.delete(installation)

        # Delete the plugin
        print(f"Deleting plugin '{slug}'...")
        db.delete(plugin)

        db.commit()
        print(f"✅ Plugin '{slug}' and all related data have been deleted.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python clean_plugin.py <slug>")
        print("Example: python clean_plugin.py github")
        sys.exit(1)

    slug = sys.argv[1]
    clean_plugin(slug)
