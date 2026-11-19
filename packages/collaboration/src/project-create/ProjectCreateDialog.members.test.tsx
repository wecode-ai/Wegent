// @vitest-environment jsdom

import { act } from "react";
import { readFileSync } from "node:fs";
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
  it("loads cloud generation models after switching from a local project", async () => {
    const setup = resourceSetup();
    setup.agents = [
      {
        id: "cloud-agent",
        name: "Cloud agent",
        owner_type: "user",
        owner_id: "1",
        owner_name: "Owner",
        status: "available",
      },
    ];
    setup.generateCollaborationGroupDraft = vi.fn();
    setup.loadCollaborationGroupGenerationModels = vi.fn(async () => ({
      defaultSelection: null,
      models: [
        {
          modelName: "cloud-model",
          modelType: "public",
          displayName: "Cloud model",
        },
      ],
    }));
    const create = vi.fn(async () => project);
    await act(async () =>
      root.render(
        <ProjectCreateDialog
          targets={[
            { location: "local", create },
            { location: "cloud", create },
          ]}
          defaultLocation="local"
          allowDingTalkAITable={false}
          labels={projectCreateLabels.en}
          resourceSetup={setup}
          onClose={() => {}}
          onCreated={() => {}}
        />,
      ),
    );
    expect(setup.loadCollaborationGroupGenerationModels).not.toHaveBeenCalled();

    await click("cloud-project-location-cloud");

    expect(setup.loadCollaborationGroupGenerationModels).not.toHaveBeenCalled();
    await click("collaboration-project-create-add-collaborator");
    await click("collaboration-project-create-collaborator-tab-agents");
    await click("collaboration-project-create-agent-cloud-agent");
    await click("collaboration-project-create-add-collaborator");
    await click("collaboration-project-create-collaborator-tab-groups");
    await click("collaboration-project-create-new-group");
    expect(setup.loadCollaborationGroupGenerationModels).toHaveBeenCalledOnce();
    await click("collaboration-project-create-configuration-back");
    await input("cloud-project-name", "Retain the cloud catalog");
    expect(setup.loadCollaborationGroupGenerationModels).toHaveBeenCalledOnce();
  });

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

  it("uses the successful smaller directory without offering cached selected identities", async () => {
    const setup = resourceSetup();
    setup.members = [
      { id: 2, user_id: 2, user_name: "Ada", email: null, role: "Developer" },
      { id: 3, user_id: 3, user_name: "Grace", email: null, role: "Developer" },
      { id: 4, user_id: 4, user_name: "Lin", email: null, role: "Developer" },
    ];
    setup.reloadMembers = vi.fn();
    await mount(setup);
    await input("cloud-project-name", "Keep my project draft");
    await click("collaboration-project-create-add-collaborator");
    await click("collaboration-project-create-member-2");
    await mount({ ...setup, membersError: "Refresh unavailable" });
    await click("collaboration-project-create-add-collaborator");
    await click("collaboration-project-create-member-search-retry");
    expect(setup.reloadMembers).toHaveBeenCalledOnce();
    await mount({ ...setup, members: [setup.members[2]] });

    expect(document.body.textContent).not.toContain("Refresh unavailable");
    expect(
      byTestId("collaboration-project-create-selected-member-2").textContent,
    ).toContain("Ada");
    expect(
      document.querySelector(
        '[data-testid="collaboration-project-create-member-3"]',
      ),
    ).toBeNull();
    expect(
      byTestId("collaboration-project-create-member-4").textContent,
    ).toContain("Lin");
    await click("collaboration-project-create-add-collaborator");
    await act(async () =>
      byTestId("collaboration-project-create-selected-member-2")
        .querySelector<HTMLButtonElement>("button")!
        .click(),
    );
    await click("collaboration-project-create-add-collaborator");
    expect(
      document.querySelector(
        '[data-testid="collaboration-project-create-member-2"]',
      ),
    ).toBeNull();
    expect((byTestId("cloud-project-name") as HTMLInputElement).value).toBe(
      "Keep my project draft",
    );
  });

  it("keeps long member failure details in the viewport-bounded scroll body outside retry and cancel", async () => {
    const setup = resourceSetup();
    const failures = Array.from({ length: 30 }, (_, index) => ({
      userId: index + 2,
      userName: `Member ${index + 2}`,
      reason: "Permission denied with a detailed explanation. ".repeat(12),
    }));
    const confirmed = Array.from({ length: 30 }, (_, index) => ({
      id: index + 40,
      user_id: index + 40,
      user_name: `Confirmed member ${index + 40}`,
      email: null,
      role: "Developer" as const,
    }));
    setup.configure = vi
      .fn()
      .mockRejectedValueOnce(new ProjectCreateMembersError(failures, confirmed))
      .mockResolvedValueOnce(undefined);
    const harness = await mount(setup);
    await input("cloud-project-name", "Recover the project");
    await click("cloud-project-create-confirm");

    const body = document.querySelector<HTMLElement>(
      ".collaboration-project-create-body",
    )!;
    const footer = document.querySelector<HTMLElement>(
      ".collaboration-project-create-footer",
    )!;
    const failureList = byTestId(
      "collaboration-project-create-member-failures",
    );
    const confirmedList = byTestId(
      "collaboration-project-create-confirmed-members",
    );
    expect(failureList.querySelectorAll("li")).toHaveLength(30);
    expect(confirmedList.querySelectorAll("li")).toHaveLength(30);
    expect(body.contains(failureList)).toBe(true);
    expect(body.contains(confirmedList)).toBe(true);
    expect(footer.contains(failureList)).toBe(false);
    expect(footer.contains(confirmedList)).toBe(false);
    expect(
      footer.contains(byTestId("collaboration-project-create-cancel")),
    ).toBe(true);
    expect(footer.contains(byTestId("cloud-project-create-confirm"))).toBe(
      true,
    );
    expect(byTestId("cloud-project-create-confirm").matches(":disabled")).toBe(
      false,
    );
    const css = readFileSync("src/platform/base.css", "utf8");
    expect(css).toMatch(
      /\.collaboration-project-create-dialog\s*\{[^}]*max-height:[^;]*100vh[^}]*overflow:\s*hidden/s,
    );
    expect(css).toMatch(
      /\.collaboration-project-create-body\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s,
    );
    expect(css).toMatch(
      /\.collaboration-project-create-footer\s*\{[^}]*flex-shrink:\s*0/s,
    );
    await click("cloud-project-create-confirm");
    expect(harness.create).toHaveBeenCalledOnce();
    expect(harness.onCreated).toHaveBeenCalledWith(project, "cloud");
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
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Ada: Forbidden");
    expect(
      alert.contains(
        byTestId("collaboration-project-create-confirmed-members"),
      ),
    ).toBe(false);
    expect(
      document.getElementById(alert.getAttribute("aria-labelledby")!)
        ?.textContent,
    ).toBe(projectCreateLabels.en.projectCreatedSetupPending);
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
