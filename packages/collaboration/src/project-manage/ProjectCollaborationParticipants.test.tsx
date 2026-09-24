// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CollaborationParticipantsTabs,
  ProjectCollaborationParticipants,
} from "./ProjectCollaborationParticipants";

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

  async function renderTabs(requestedTab?: "agents" | "members" | "groups") {
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
          requestedTab={requestedTab}
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

  it("selects a tab requested by the settings host", async () => {
    await renderTabs();
    expect(tab("agents").getAttribute("aria-selected")).toBe("true");

    await renderTabs("members");

    expect(tab("members").getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("Members content");
    expect(container.textContent).not.toContain("Agents content");
  });

  it("uses the wide settings layout for collaboration resources", async () => {
    await act(async () => {
      root.render(
        <ProjectCollaborationParticipants
          agentsContent={<div>Agents content</div>}
          groupsContent={<div>Groups content</div>}
          membersContent={<div>Members content</div>}
          translate={(_key, fallback) => fallback ?? ""}
        />,
      );
    });

    expect(
      container
        .querySelector(
          '[data-testid="collaboration-project-participants-page"]',
        )
        ?.firstElementChild?.classList.contains("max-w-5xl"),
    ).toBe(true);
  });

  it("shows project manager as a separate project participant tab", async () => {
    await act(async () => {
      root.render(
        <ProjectCollaborationParticipants
          agentsContent={<div>Agents content</div>}
          managerContent={<div>Manager settings</div>}
          groupsContent={<div>Groups content</div>}
          membersContent={<div>Members content</div>}
          translate={(_key, fallback) => fallback ?? ""}
        />,
      );
    });

    const managerTab = container.querySelector<HTMLButtonElement>(
      '[data-testid="collaboration-participants-tab-manager"]',
    );
    expect(managerTab).not.toBeNull();
    expect(Array.from(container.querySelectorAll('[role="tab"]')).map(tab => tab.getAttribute('data-testid'))).toEqual([
      'collaboration-participants-tab-agents',
      'collaboration-participants-tab-members',
      'collaboration-participants-tab-groups',
      'collaboration-participants-tab-manager',
    ]);
    await act(async () => managerTab?.click());
    expect(
      container.querySelector(
        '[data-testid="collaboration-participants-panel-manager"]',
      )?.textContent,
    ).toContain("Manager settings");
    expect(container.textContent).not.toContain("Agents content");
  });
});
