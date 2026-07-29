# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Publish packaged system plugins to the Wegent marketplace."""

from __future__ import annotations

import io
import json
import logging
import stat
import zipfile
from pathlib import Path

from sqlalchemy.orm import Session

from app.core.config import settings
from app.schemas.installed_plugin import PluginMarketplaceItem
from app.services.builtin_plugin_registry import (
    BUILTIN_PLUGIN_OWNER_ID,
    BUILTIN_PLUGINS,
)
from app.services.installed_plugin_service import installed_plugin_service

logger = logging.getLogger(__name__)

ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


class BuiltinPluginService:
    """Keep packaged built-in plugins available in the cloud marketplace."""

    def sync_marketplace_plugins(
        self,
        db: Session,
        *,
        plugins_dir: Path | None = None,
    ) -> list[PluginMarketplaceItem]:
        source_dir = plugins_dir or self._resolve_plugins_dir()
        self.validate_required_plugins(source_dir)
        deactivated = (
            installed_plugin_service.deactivate_non_system_builtin_marketplace_items(db)
        )
        if deactivated:
            logger.info(
                "Deactivated non-system built-in marketplace entries: count=%s",
                deactivated,
            )

        if not source_dir.is_dir():
            logger.warning(
                "Built-in plugin directory is unavailable: path=%s",
                source_dir,
            )
            return []

        published: list[PluginMarketplaceItem] = []
        for plugin in BUILTIN_PLUGINS:
            plugin_dir = source_dir / plugin.name
            if not plugin_dir.is_dir():
                logger.warning(
                    "Built-in plugin is unavailable: plugin=%s path=%s",
                    plugin.name,
                    plugin_dir,
                )
                continue

            package_bytes = self._package_plugin_directory(plugin_dir)
            item = installed_plugin_service.publish_marketplace_plugin(
                db=db,
                user_id=BUILTIN_PLUGIN_OWNER_ID,
                package_bytes=package_bytes,
                filename=f"{plugin.name}.zip",
                visibility=plugin.visibility,
                featured=plugin.featured,
            )
            if item.name != plugin.name:
                raise ValueError(
                    f"Expected built-in plugin {plugin.name!r}, received {item.name!r}"
                )
            published.append(item)
            logger.info(
                "Built-in plugin published: plugin=%s version=%s marketplace_id=%s",
                item.name,
                item.version,
                item.id,
            )
        return published

    def validate_required_plugins(self, plugins_dir: Path | None = None) -> None:
        """Fail when a required staged plugin is absent or has an invalid manifest."""
        source_dir = plugins_dir or self._resolve_plugins_dir()
        required_plugins = [plugin for plugin in BUILTIN_PLUGINS if plugin.required]
        if not required_plugins:
            return
        if not source_dir.is_dir():
            names = ", ".join(plugin.name for plugin in required_plugins)
            raise RuntimeError(
                "Required built-in plugin directory is unavailable: "
                f"path={source_dir} plugins={names}"
            )

        errors = []
        for plugin in required_plugins:
            plugin_dir = source_dir / plugin.name
            manifest_path = plugin_dir / ".codex-plugin" / "plugin.json"
            if not plugin_dir.is_dir():
                errors.append(f"{plugin.name}: directory is missing")
                continue
            if not manifest_path.is_file():
                errors.append(f"{plugin.name}: manifest is missing")
                continue
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                errors.append(f"{plugin.name}: manifest is invalid ({exc})")
                continue
            if manifest.get("name") != plugin.name:
                errors.append(
                    f"{plugin.name}: manifest name is {manifest.get('name')!r}"
                )

        if errors:
            raise RuntimeError(
                "Required built-in plugins are unavailable: "
                f"path={source_dir} errors={'; '.join(errors)}"
            )

    def _resolve_plugins_dir(self) -> Path:
        configured = Path(settings.BUILTIN_PLUGINS_DIR)
        if configured.is_dir() or not configured.is_absolute():
            return configured

        return Path(__file__).resolve().parents[2] / "init_data" / "plugins"

    def _package_plugin_directory(self, plugin_dir: Path) -> bytes:
        buffer = io.BytesIO()
        with zipfile.ZipFile(
            buffer,
            mode="w",
            compression=zipfile.ZIP_DEFLATED,
        ) as archive:
            for path in sorted(plugin_dir.rglob("*")):
                if not path.is_file() or path.name == ".DS_Store":
                    continue
                relative_path = path.relative_to(plugin_dir).as_posix()
                mode = stat.S_IMODE(path.stat().st_mode)
                content = path.read_bytes()
                self._write_archive_file(
                    archive,
                    relative_path=relative_path,
                    content=content,
                    mode=mode,
                )
        return buffer.getvalue()

    @staticmethod
    def _write_archive_file(
        archive: zipfile.ZipFile,
        *,
        relative_path: str,
        content: bytes,
        mode: int,
    ) -> None:
        info = zipfile.ZipInfo(relative_path, date_time=ZIP_TIMESTAMP)
        info.create_system = 3
        info.external_attr = mode << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, content)


builtin_plugin_service = BuiltinPluginService()
