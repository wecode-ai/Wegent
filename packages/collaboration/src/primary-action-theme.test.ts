// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
}

describe("collaboration primary action theme", () => {
  it("allows the host to override primary actions while preserving neutral defaults", () => {
    const sources = [
      source("./platform/base.css"),
      source("./project-agent-config/ProjectAgentConfiguration.module.css"),
    ];

    for (const css of sources) {
      expect(css).toContain("--collaboration-primary-background");
      expect(css).toContain("--collaboration-primary-foreground");
      expect(css).toContain("rgb(var(--color-text-primary))");
      expect(css).toContain("rgb(var(--color-bg-base))");
    }
  });
});
