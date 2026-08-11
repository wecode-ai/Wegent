# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Passthrough hook for administrator-selected plugin mirrors.

Upstream packages are published as-is. Do not rewrite manifests, connectors,
localization, or assets here — brand icons and runtime integration belong in
the official plugin package.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AdaptedUpstreamPackage:
    """Package bytes plus optional adapter provenance."""

    package: bytes
    adapter: str | None = None
    adapter_version: str | None = None
    upstream_version: str | None = None


def adapt_upstream_package(
    *,
    provider: str,
    marketplace_name: str,
    remote_plugin_id: str,
    package: bytes,
) -> AdaptedUpstreamPackage:
    """Return the upstream package unchanged."""
    _ = (provider, marketplace_name, remote_plugin_id)
    return AdaptedUpstreamPackage(package=package)
