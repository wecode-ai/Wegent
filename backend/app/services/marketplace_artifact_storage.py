# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared immutable object storage adapter for marketplace artifacts."""

from app.services.plugin_package_storage import (
    PluginPackageStorageError,
    plugin_package_storage,
)

MarketplaceArtifactStorageError = PluginPackageStorageError
marketplace_artifact_storage = plugin_package_storage

__all__ = ["MarketplaceArtifactStorageError", "marketplace_artifact_storage"]
