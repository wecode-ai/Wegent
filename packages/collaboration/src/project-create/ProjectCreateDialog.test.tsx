// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CollaborationProject } from "../types";
import { ProjectCreateDialog } from "./ProjectCreateDialog";
import { ProjectCreateMembersError } from "./configureProjectMembers";
import { projectCreateLabels } from "./labels";
import type { ProjectCreateResourceSetup } from "./types";

let root: Root;
let container: HTMLDivElement;
const project = {
  id: "created-project",
  name: "Research",
} as CollaborationProject;

function byTestId(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`Missing ${id}`);
  return element;
}

async function click(id: string) {
  await act(async () => byTestId(id).click());
}

async function input(id: string, value: string) {
  const element = byTestId(id) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(200);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(
  setup: ProjectCreateResourceSetup,
  location: "local" | "cloud" = "cloud",
) {
  const create = vi.fn(async () => project);
  const onCreated = vi.fn();
  await act(async () =>
    root.render(
      <ProjectCreateDialog
        targets={[{ location, create }]}
        defaultLocation={location}
        allowDingTalkAITable={false}
        labels={projectCreateLabels.en}
        resourceSetup={setup}
        onClose={() => {}}
        onCreated={onCreated}
      />,
    ),
  );
  return { create, onCreated };
}

function resourceSetup(): ProjectCreateResourceSetup {
  return {
    location: "cloud",
    currentUser: { id: 1, name: "Owner" },
    members: [],
    agents: [],
    groups: [],
    configure: vi.fn(async () => {}),
  };
}

describe("shared project creation members", () => {
  it("keeps selected directory members visible when resource loading fails and exposes retry", async () => {
    const setup = resourceSetup();
    setup.members = [
      { id: 2, user_id: 2, user_name: "Ada", email: null, role: "Developer" },
    ];
    setup.reloadMembers = vi.fn();
    await mount(setup);
    await input("cloud-project-name", "Research");
    await click("collaboration-project-create-add-collaborator");
    await click("collaboration-project-create-member-2");
    await mount({
      ...setup,
      members: [],
      membersError: "Directory load failed",
    });

    expect(
      byTestId("collaboration-project-create-selected-member-2").textContent,
    ).toContain("Ada");
    expect((byTestId("cloud-project-name") as HTMLInputElement).value).toBe(
      "Research",
    );
    await click("collaboration-project-create-add-collaborator");
    expect(document.body.textContent).toContain("Directory load failed");
    await click("collaboration-project-create-member-search-retry");
    expect(setup.reloadMembers).toHaveBeenCalledTimes(1);
  });

  it("keeps multi-selection and the project draft after a search failure and retry", async () => {
    const setup = resourceSetup();
    setup.searchUsers = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 1, user_name: "Owner", email: null },
        { id: 2, user_name: "Ada", email: null },
        { id: 3, user_name: "Grace", email: null },
      ])
      .mockResolvedValueOnce([
        { id: 1, user_name: "Owner", email: null },
        { id: 2, user_name: "Ada", email: null },
        { id: 3, user_name: "Grace", email: null },
      ])
      .mockRejectedValueOnce(new Error("Directory unavailable"))
      .mockResolvedValueOnce([{ id: 4, user_name: "Lin", email: null }]);
    await mount(setup);
    await input("cloud-project-name", "Research");
    await click("collaboration-project-create-add-collaborator");
    await input("collaboration-project-create-people-search", "a");
    expect(
      document.querySelector(
        '[data-testid="collaboration-project-create-member-1"]',
      ),
    ).toBeNull();
    await click("collaboration-project-create-member-2");
    await click("collaboration-project-create-add-collaborator");
    await input("collaboration-project-create-people-search", "a");
    expect(
      document.querySelector(
        '[data-testid="collaboration-project-create-member-2"]',
      ),
    ).toBeNull();
    await click("collaboration-project-create-member-3");

    await click("collaboration-project-create-add-collaborator");
    await input("collaboration-project-create-people-search", "Lin");
    expect(document.body.textContent).toContain("Directory unavailable");
    expect(
      byTestId("collaboration-project-create-selected-member-2").textContent,
    ).toContain("Ada");
    expect(
      byTestId("collaboration-project-create-selected-member-3").textContent,
    ).toContain("Grace");
    expect((byTestId("cloud-project-name") as HTMLInputElement).value).toBe(
      "Research",
    );
    await click("collaboration-project-create-member-search-retry");
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(
      byTestId("collaboration-project-create-member-4").textContent,
    ).toContain("Lin");
    expect(setup.searchUsers).toHaveBeenCalledTimes(4);
  });

  it("names failed selected members, shows the verified roster and retries the created project", async () => {
    const setup = resourceSetup();
    setup.searchUsers = vi.fn(async () => [
      { id: 2, user_name: "Ada", email: null },
    ]);
    setup.configure = vi
      .fn()
      .mockRejectedValueOnce(
        new ProjectCreateMembersError(
          [{ userId: 2, userName: "2", reason: "Forbidden" }],
          [
            {
              id: 1,
              user_id: 1,
              user_name: "Owner",
              email: null,
              role: "Owner",
            },
          ],
        ),
      )
      .mockResolvedValueOnce(undefined);
    const harness = await mount(setup);
    await input("cloud-project-name", "Research");
    await click("collaboration-project-create-add-collaborator");
    await input("collaboration-project-create-people-search", "Ada");
    await click("collaboration-project-create-member-2");
    await click("cloud-project-create-confirm");

    expect(
      byTestId("collaboration-project-create-member-failures").textContent,
    ).toContain("Ada: Forbidden");
    expect(
      byTestId("collaboration-project-create-confirmed-members").textContent,
    ).toContain("Owner");
    expect(byTestId("cloud-project-create-confirm").textContent).toBe(
      "Retry project setup",
    );
    expect(byTestId("cloud-project-name").matches(":disabled")).toBe(true);
    expect(byTestId("cloud-project-name").closest("fieldset")?.disabled).toBe(
      true,
    );
    await click("cloud-project-create-confirm");
    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(setup.configure).toHaveBeenCalledTimes(2);
    expect(harness.onCreated).toHaveBeenCalledWith(project, "cloud");
  });

  it("hides a cloud member source for local creation and explains the limitation", async () => {
    const setup = resourceSetup();
    setup.searchUsers = vi.fn(async () => []);
    await mount(setup, "local");

    expect(
      byTestId("collaboration-project-create-members-unavailable").textContent,
    ).toContain("Local projects");
    expect(
      document.querySelector(
        '[data-testid="collaboration-project-create-add-collaborator"]',
      ),
    ).toBeNull();
    await input("cloud-project-name", "Local");
    await click("cloud-project-create-confirm");
    expect(setup.configure).not.toHaveBeenCalled();
    expect(setup.searchUsers).not.toHaveBeenCalled();
  });
});
