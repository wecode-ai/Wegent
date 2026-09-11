// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { WorkflowProjectPluginRef } from "./automation";

export interface InstalledPluginCatalogItem {
  metadata?: Record<string, unknown>;
  spec?: {
    source?: {
      pluginKey?: unknown;
      marketplace?: unknown;
      catalogItemId?: unknown;
      providerKey?: unknown;
    };
    displayName?: unknown;
    installState?: unknown;
    enabled?: unknown;
    manifest?: Record<string, unknown>;
  };
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeInstalledPluginProjectRef(
  plugin: InstalledPluginCatalogItem,
): WorkflowProjectPluginRef | null {
  const spec = plugin.spec;
  if (!spec || spec.enabled === false) return null;
  if (
    !["installed", "update_available"].includes(
      trimmedString(spec.installState),
    )
  )
    return null;

  const source = spec.source;
  const pluginName = trimmedString(source?.pluginKey);
  const marketplaceId =
    trimmedString(source?.marketplace) ||
    trimmedString(spec.manifest?.marketplaceId) ||
    trimmedString(source?.providerKey) ||
    trimmedString(source?.catalogItemId);
  if (!pluginName || !marketplaceId) return null;

  const displayName = trimmedString(spec.displayName) || pluginName;
  return {
    id: `${pluginName}@${marketplaceId}`,
    pluginName,
    marketplaceId,
    displayName,
  };
}

export function mergeProjectPluginCatalogs(
  ...catalogs: WorkflowProjectPluginRef[][]
): WorkflowProjectPluginRef[] {
  const merged = new Map<string, WorkflowProjectPluginRef>();
  catalogs.flat().forEach((plugin) => {
    const key = `${normalized(plugin.pluginName)}@${normalized(plugin.marketplaceId)}`;
    if (key === "@") return;
    const current = merged.get(key);
    merged.set(key, {
      ...(current ?? plugin),
      ...plugin,
      displayName:
        current && current.displayName !== current.pluginName
          ? current.displayName
          : plugin.displayName,
    });
  });
  return Array.from(merged.values()).sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

export function buildInstalledPluginProjectCatalog(
  installedPlugins: InstalledPluginCatalogItem[],
): WorkflowProjectPluginRef[] {
  return mergeProjectPluginCatalogs(
    installedPlugins.flatMap((plugin) => {
      const reference = normalizeInstalledPluginProjectRef(plugin);
      return reference ? [reference] : [];
    }),
  );
}
