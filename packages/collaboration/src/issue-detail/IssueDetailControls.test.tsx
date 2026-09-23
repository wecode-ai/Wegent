// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollaborationTheme } from "../theme";
import { IssueDetailSearchableSelect } from "./IssueDetailControls";

describe("IssueDetailSearchableSelect", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function renderSelect() {
    await act(async () => {
      root.render(
        <CollaborationTheme mode="light">
          <IssueDetailSearchableSelect
            value=""
            testId="assignee"
            accessibleLabel="负责人"
            className="trigger"
            searchPlaceholder="搜索负责人"
            emptyLabel="没有匹配的负责人"
            groupLimit={3}
            showAllLabel={(_group, count) => `查看全部 ${count} 个`}
            options={[
              { value: "", label: "未指派" },
              ...Array.from({ length: 7 }, (_, index) => ({
                value: `group:${index + 1}`,
                label: `协作小组 ${index + 1}`,
                group: "协作小组",
              })),
              { value: "user:1", label: "我", group: "成员" },
            ]}
            onChange={vi.fn()}
          />
        </CollaborationTheme>,
      );
    });
  }

  async function click(element: Element) {
    await act(async () => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  async function change(element: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(element, value);
    await act(async () => {
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  function portalByTestId(testId: string) {
    return document.body.querySelector<HTMLElement>(
      `[data-testid="${testId}"]`,
    );
  }

  it("limits large groups and expands them without hiding other sections", async () => {
    await renderSelect();
    await click(container.querySelector('[data-testid="assignee"]')!);

    expect(portalByTestId("assignee-option-group:1")).not.toBeNull();
    expect(portalByTestId("assignee-option-group:3")).not.toBeNull();
    expect(portalByTestId("assignee-option-group:4")).toBeNull();
    expect(portalByTestId("assignee-option-user:1")).not.toBeNull();

    await click(portalByTestId("assignee-show-all-协作小组")!);

    expect(portalByTestId("assignee-option-group:7")).not.toBeNull();
    expect(portalByTestId("assignee-show-all-协作小组")).toBeNull();
  });

  it("searches all candidates even when their group is initially limited", async () => {
    await renderSelect();
    await click(container.querySelector('[data-testid="assignee"]')!);

    await change(
      portalByTestId("assignee-search") as HTMLInputElement,
      "协作小组 7",
    );

    expect(portalByTestId("assignee-option-group:7")).not.toBeNull();
    expect(portalByTestId("assignee-option-group:1")).toBeNull();
    expect(portalByTestId("assignee-show-all-协作小组")).toBeNull();
  });
});
