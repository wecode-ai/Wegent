// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { boardCardIdFromDropId, projectBoardDrop } from "./projectBoardDnd";

describe("project board drop identity", () => {
  it("retains both the Issue and target lane when a card appears under multiple tags", () => {
    const event = {
      active: {
        id: JSON.stringify(["tag-backend", "source"]),
        data: { current: { itemId: "source" } },
      },
      over: {
        id: `todo-card:${JSON.stringify(["tag-shared", "target"])}`,
        data: { current: { columnKey: "tag-shared" } },
      },
    } as unknown as Parameters<typeof projectBoardDrop>[0];
    expect(projectBoardDrop(event)).toEqual({
      activeItemId: "source",
      beforeItemId: "target",
      columnDropKey: "tag-shared",
    });
    expect(
      boardCardIdFromDropId(
        `todo-card:${JSON.stringify(["tag-backend", "target"])}`,
      ),
    ).toBe("target");
    expect(boardCardIdFromDropId("todo-column:tag-shared")).toBeNull();
  });
});
