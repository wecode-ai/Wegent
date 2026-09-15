// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollaborationParticipantsTabs } from "./ProjectCollaborationParticipants";

describe("CollaborationParticipantsTabs", () => {
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

  async function renderTabs() {
    await act(async () => {
      root.render(
        <CollaborationParticipantsTabs
          agentsContent={<div>Agents content</div>}
          agentsLabel="智能体"
          ariaLabel="协作成员"
          membersContent={<div>Members content</div>}
          membersLabel="项目成员"
          groupsContent={<div>Groups content</div>}
          groupsLabel="协作小组"
        />,
      );
    });
  }

  function tab(id: "agents" | "members" | "groups") {
    return container.querySelector<HTMLButtonElement>(
      `[data-testid="collaboration-participants-tab-${id}"]`,
    )!;
  }

  async function press(element: HTMLElement, key: string) {
    await act(async () => {
      element.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key }),
      );
    });
  }

  it("uses a single tab stop and moves selection with arrow keys", async () => {
    await renderTabs();

    expect(tab("agents").tabIndex).toBe(0);
    expect(tab("members").tabIndex).toBe(-1);
    expect(tab("groups").tabIndex).toBe(-1);

    tab("agents").focus();
    await press(tab("agents"), "ArrowRight");

    expect(document.activeElement).toBe(tab("members"));
    expect(tab("members").getAttribute("aria-selected")).toBe("true");
    expect(tab("members").tabIndex).toBe(0);
    expect(tab("agents").tabIndex).toBe(-1);

    await press(tab("members"), "ArrowLeft");
    expect(document.activeElement).toBe(tab("agents"));

    await press(tab("agents"), "ArrowLeft");
    expect(document.activeElement).toBe(tab("groups"));
  });

  it("moves to the first and last tabs with Home and End", async () => {
    await renderTabs();

    tab("agents").focus();
    await press(tab("agents"), "End");
    expect(document.activeElement).toBe(tab("groups"));
    expect(tab("groups").getAttribute("aria-selected")).toBe("true");

    await press(tab("groups"), "Home");
    expect(document.activeElement).toBe(tab("agents"));
    expect(tab("agents").getAttribute("aria-selected")).toBe("true");
  });
});
