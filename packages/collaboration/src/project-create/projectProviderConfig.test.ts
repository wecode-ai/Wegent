// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  RepositoryProviderError,
  repositoryProviderConfig,
} from "./projectProviderConfig";

describe("repositoryProviderConfig", () => {
  it("normalizes shorthand and hosted repository URLs", () => {
    expect(repositoryProviderConfig("acme/repo.git", "github")).toEqual({
      repository: "acme/repo",
    });
    expect(
      repositoryProviderConfig(
        "https://gitlab.example.com/platform/workbench/-/issues",
        "gitlab",
      ),
    ).toEqual({
      repository: "platform/workbench",
      domain: "gitlab.example.com",
      api_base: "https://gitlab.example.com/api/v4",
    });
  });

  it("rejects repository addresses without an owner or group", () => {
    expect(() =>
      repositoryProviderConfig("https://github.com/acme", "github"),
    ).toThrow(
      expect.objectContaining<Partial<RepositoryProviderError>>({
        code: "github_repository_invalid",
      }),
    );
  });
});
