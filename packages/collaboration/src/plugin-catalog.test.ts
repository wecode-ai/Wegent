// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildInstalledPluginProjectCatalog,
  mergeProjectPluginCatalogs,
  normalizeInstalledPluginProjectRef,
} from "./plugin-catalog";

function installedPlugin(
  source: Record<string, unknown>,
  manifest: Record<string, unknown> = {},
) {
  return {
    metadata: { name: "installed-record" },
    spec: {
      source,
      displayName: "Plugin label",
      installState: "installed",
      enabled: true,
      manifest,
    },
  };
}

describe("plugin catalog", () => {
  it("normalizes marketplace plugins to a canonical project reference", () => {
    expect(
      normalizeInstalledPluginProjectRef(
        installedPlugin({
          pluginKey: "github",
          marketplace: "official",
          catalogItemId: "catalog-entry",
          providerKey: "wegent-market",
        }),
      ),
    ).toEqual({
      id: "github@official",
      pluginName: "github",
      marketplaceId: "official",
      displayName: "Plugin label",
    });
  });

  it.each([
    {
      name: "catalog item",
      source: {
        type: "upload",
        pluginKey: "uploaded",
        providerKey: "",
        catalogItemId: "upload-catalog",
      },
      manifest: {},
      marketplaceId: "upload-catalog",
    },
    {
      name: "manifest marketplace",
      source: {
        type: "local",
        pluginKey: "local-manifest",
        providerKey: "codex-local",
      },
      manifest: { marketplaceId: "personal-marketplace" },
      marketplaceId: "personal-marketplace",
    },
    {
      name: "provider",
      source: {
        type: "local",
        pluginKey: "local-provider",
        providerKey: "codex-local",
      },
      manifest: {},
      marketplaceId: "codex-local",
    },
  ])(
    "keeps upload/local plugins by their $name identity",
    ({ source, manifest, marketplaceId }) => {
      const reference = normalizeInstalledPluginProjectRef(
        installedPlugin(source, manifest),
      );

      expect(reference).toMatchObject({
        marketplaceId,
        pluginName: source.pluginKey,
      });
      expect(reference?.id).toBe(`${source.pluginKey}@${marketplaceId}`);
    },
  );

  it("excludes disabled, unavailable, or unidentified plugins", () => {
    const pendingPlugin = installedPlugin({
      pluginKey: "pending",
      providerKey: "local",
    });
    pendingPlugin.spec.installState = "pending";

    expect(
      buildInstalledPluginProjectCatalog([
        {
          spec: {
            source: { pluginKey: "disabled", providerKey: "local" },
            displayName: "Disabled",
            installState: "installed",
            enabled: false,
            manifest: {},
          },
        },
        pendingPlugin,
        installedPlugin({ pluginKey: "missing-identity" }),
      ]),
    ).toEqual([]);
  });

  it("accepts update-available plugins and merges duplicate identities", () => {
    const updateAvailable = installedPlugin({
      pluginKey: "github",
      providerKey: "official",
    });
    updateAvailable.spec.installState = "update_available";

    expect(
      mergeProjectPluginCatalogs(
        [
          {
            id: "github@official",
            pluginName: "github",
            marketplaceId: "official",
            displayName: "GitHub App",
          },
        ],
        buildInstalledPluginProjectCatalog([updateAvailable]),
      ),
    ).toEqual([
      {
        id: "github@official",
        pluginName: "github",
        marketplaceId: "official",
        displayName: "GitHub App",
      },
    ]);
  });
});
