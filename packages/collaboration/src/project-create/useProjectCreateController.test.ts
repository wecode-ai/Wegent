// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { projectCreateLabels } from "./labels";
import { RepositoryProviderError } from "./projectProviderConfig";
import { projectCreateErrorMessage } from "./useProjectCreateController";

describe("projectCreateErrorMessage", () => {
  it("maps stable repository validation codes through the active locale", () => {
    expect(
      projectCreateErrorMessage(
        new RepositoryProviderError("github_repository_invalid"),
        projectCreateLabels.en,
      ),
    ).toBe("A GitHub repository must include owner/repository");
    expect(
      projectCreateErrorMessage(
        new RepositoryProviderError("repository_required"),
        projectCreateLabels["zh-CN"],
      ),
    ).toBe("请输入仓库地址");
  });
});
