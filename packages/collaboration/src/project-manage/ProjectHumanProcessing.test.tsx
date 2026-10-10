// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProjectHumanProcessing } from "./ProjectHumanProcessing";

describe("ProjectHumanProcessing", () => {
  it("explains the human workflow without asking an admin for more configuration", () => {
    const markup = renderToStaticMarkup(
      <ProjectHumanProcessing translate={(_key, fallback) => fallback ?? ""} />,
    );

    expect(markup).toContain("人工处理 · AI 辅助");
    expect(markup).toContain("退回时只填写原因");
    expect(markup).not.toMatch(/<(?:input|textarea|select)\b/);
  });
});
