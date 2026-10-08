// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { issueDraftFromText } from "./issueDraft";

describe("issueDraftFromText", () => {
  it("derives a compact title while preserving the complete content", () => {
    expect(
      issueDraftFromText("完成发布验证\n覆盖创建和完成链路\n补充截图"),
    ).toEqual({
      title: "完成发布验证 覆盖创建和完成链路 补充截图",
      description: "完成发布验证\n覆盖创建和完成链路\n补充截图",
    });
  });

  it("returns an empty draft for whitespace-only content", () => {
    expect(issueDraftFromText(" \n\t ")).toEqual({
      title: "",
      description: "",
    });
  });
});
