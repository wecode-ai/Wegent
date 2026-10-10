// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { defaultScheduleViewOptions } from "./model";
import {
  readPersonalScheduleViewOptions,
  writePersonalScheduleViewOptions,
} from "./useProjectScheduleViewOptions";

describe("project schedule personal view options", () => {
  it("persists valid personal options and clears them on reset", () => {
    let value: string | null = null;
    const storage = {
      getItem: vi.fn(() => value),
      setItem: vi.fn((_key: string, next: string) => {
        value = next;
      }),
      removeItem: vi.fn(() => {
        value = null;
      }),
    };
    const options = {
      ...defaultScheduleViewOptions,
      status: "pending",
      groupBy: "status" as const,
    };

    writePersonalScheduleViewOptions(storage, "schedule-key", options);
    expect(readPersonalScheduleViewOptions(storage, "schedule-key")).toEqual(
      options,
    );

    writePersonalScheduleViewOptions(storage, "schedule-key", null);
    expect(storage.removeItem).toHaveBeenCalledWith("schedule-key");
    expect(readPersonalScheduleViewOptions(storage, "schedule-key")).toBeNull();
  });

  it("ignores malformed persisted options", () => {
    const storage = {
      getItem: vi.fn(() => '{"groupBy":"invalid"}'),
    };

    expect(readPersonalScheduleViewOptions(storage, "schedule-key")).toBeNull();
  });

  it("keeps working when browser storage rejects writes", () => {
    const storage = {
      setItem: vi.fn(() => {
        throw new DOMException("Storage is disabled");
      }),
      removeItem: vi.fn(() => {
        throw new DOMException("Storage is disabled");
      }),
    };

    expect(() =>
      writePersonalScheduleViewOptions(
        storage,
        "schedule-key",
        defaultScheduleViewOptions,
      ),
    ).not.toThrow();
    expect(() =>
      writePersonalScheduleViewOptions(storage, "schedule-key", null),
    ).not.toThrow();
  });
});
