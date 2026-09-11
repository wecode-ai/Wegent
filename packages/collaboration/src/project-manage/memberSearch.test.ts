// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  clearMemberResultsForEmptyQuery,
  runActiveMemberSearch,
} from "./memberSearch";

describe("member search", () => {
  it("clears stale results immediately when the query becomes empty", () => {
    const onResults = vi.fn();

    expect(clearMemberResultsForEmptyQuery("  ", onResults)).toBe(true);
    expect(onResults).toHaveBeenCalledWith([]);
    expect(clearMemberResultsForEmptyQuery("Ada", onResults)).toBe(false);
  });

  it("clears results and reports an active request failure", async () => {
    const cause = new Error("search unavailable");
    const onResults = vi.fn();
    const onError = vi.fn();

    await runActiveMemberSearch({
      query: "Ada",
      existingUserIds: new Set(),
      search: vi.fn().mockRejectedValue(cause),
      userId: (user: { id: number }) => user.id,
      isActive: () => true,
      onResults,
      onError,
    });

    expect(onResults).toHaveBeenCalledWith([]);
    expect(onError).toHaveBeenCalledWith(cause);
  });

  it("does not update results or errors after the request becomes stale", async () => {
    const onResults = vi.fn();
    const onError = vi.fn();

    await runActiveMemberSearch({
      query: "Ada",
      existingUserIds: new Set(),
      search: vi.fn().mockRejectedValue(new Error("late failure")),
      userId: (user: { id: number }) => user.id,
      isActive: () => false,
      onResults,
      onError,
    });

    expect(onResults).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("filters existing members from active successful results", async () => {
    const onResults = vi.fn();

    await runActiveMemberSearch({
      query: "Ada",
      existingUserIds: new Set([1]),
      search: vi.fn().mockResolvedValue({
        users: [
          { id: 1, name: "Existing" },
          { id: 2, name: "Ada" },
        ],
      }),
      userId: (user) => user.id,
      isActive: () => true,
      onResults,
      onError: vi.fn(),
    });

    expect(onResults).toHaveBeenCalledWith([{ id: 2, name: "Ada" }]);
  });
});
