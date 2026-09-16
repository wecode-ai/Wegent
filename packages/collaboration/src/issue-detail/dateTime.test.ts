// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  dueDateTimeLocalFromSource,
  dueDateTimeLocalToSource,
} from "./dateTime";

describe("collaboration due date conversion", () => {
  it("keeps date-only values editable without changing their calendar day", () => {
    expect(dueDateTimeLocalFromSource("2026-09-12")).toBe("2026-09-12T00:00");
  });

  it("preserves an unchanged date-only source value", () => {
    expect(
      dueDateTimeLocalToSource("2026-09-12T00:00", {
        sourceValue: "2026-09-12",
        sourceInputValue: "2026-09-12T00:00",
      }),
    ).toBe("2026-09-12");
  });

  it("converts UTC values to and from the browser local time", () => {
    vi.stubEnv("TZ", "Asia/Shanghai");

    expect(dueDateTimeLocalFromSource("2026-09-12T02:30:00Z")).toBe(
      "2026-09-12T10:30",
    );
    expect(dueDateTimeLocalToSource("2026-09-12T10:30")).toBe(
      "2026-09-12T02:30:00.000Z",
    );

    vi.unstubAllEnvs();
  });

  it("converts an edited local value even when the source was date-only", () => {
    vi.stubEnv("TZ", "Asia/Shanghai");

    expect(
      dueDateTimeLocalToSource("2026-09-12T10:30", {
        sourceValue: "2026-09-12",
        sourceInputValue: "2026-09-12T00:00",
      }),
    ).toBe("2026-09-12T02:30:00.000Z");

    vi.unstubAllEnvs();
  });
});
