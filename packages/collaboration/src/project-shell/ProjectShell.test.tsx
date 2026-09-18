// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveProjectShellLevel } from "./ProjectShell";

describe("ProjectShell", () => {
  it("keeps the complete header at its natural width", () => {
    expect(
      resolveProjectShellLevel({
        assistantOpen: false,
        boardView: true,
        hasCreateAction: true,
        widths: {
          add: 112,
          assistant: 92,
          available: 900,
          search: 104,
          title: 168,
          viewSwitcher: 260,
        },
      }),
    ).toBe(0);
  });

  it("progressively hides labels and then the title at narrow widths", () => {
    const widths = {
      add: 112,
      assistant: 92,
      search: 104,
      title: 168,
      viewSwitcher: 260,
    };

    expect(
      resolveProjectShellLevel({
        assistantOpen: false,
        boardView: true,
        hasCreateAction: true,
        widths: { ...widths, available: 600 },
      }),
    ).toBe(1);
    expect(
      resolveProjectShellLevel({
        assistantOpen: false,
        boardView: true,
        hasCreateAction: true,
        widths: { ...widths, available: 260 },
      }),
    ).toBe(2);
  });
});
