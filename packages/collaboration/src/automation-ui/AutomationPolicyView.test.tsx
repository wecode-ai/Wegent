// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AutomationUiRule, AutomationUiStep } from "../automation";
import { AutomationPolicyView } from "./AutomationPolicyView";
import {
  AutomationUiHostProvider,
  type AutomationUiHost,
} from "./AutomationUiHost";

function step(id: string): AutomationUiStep {
  return {
    id,
    name: "Project manager agent",
    prompt: "Coordinate this issue",
    kind: "dynamic",
    dependencies: [],
    dependencyContext: {},
    x: 0,
    y: 0,
    deliverables: [],
    modelOptions: {},
    plugins: [],
    projectPlugins: [],
    executionConfig: null,
    subgraph: { nodes: [] },
  } as AutomationUiStep;
}

function rule(
  id: string,
  name: string,
  values: Partial<AutomationUiRule> = {},
): AutomationUiRule {
  return {
    id,
    persisted: true,
    origin: "automation",
    version: 1,
    name,
    description: "",
    enabled: true,
    updatedAt: "2026-09-13T00:00:00Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    trigger: {
      type: "event",
      source: "wework",
      collectionMode: "internal",
      startMode: "immediate",
      event: "created",
      tags: [],
      schedule: {
        frequency: "daily",
        weekday: "monday",
        time: "09:00",
        timezone: "Asia/Shanghai",
      },
    },
    steps: [step(`step-${id}`)],
    legacyDefinition: null,
    runtimeSource: "runtime_user",
    ...values,
  };
}

const host: AutomationUiHost = {
  locale: "en",
  useTranslation: () => ({ t: (key: string) => key }),
  PopupMenu: () => null,
  Tooltip: () => null,
  EventSubscriptionPicker: () => null,
};

const projectAgents = [
  { id: "agent-claude", name: "Claude" },
  { id: "agent-codex", name: "Codex" },
];

function element(testId: string): HTMLElement {
  const found = document.querySelector(`[data-testid="${testId}"]`);
  if (!(found instanceof HTMLElement)) {
    throw new Error(`Missing ${testId}`);
  }
  return found;
}

async function click(testId: string) {
  await act(async () => {
    element(testId).click();
  });
}

async function change(testId: string, value: string) {
  const target = element(testId) as HTMLInputElement | HTMLSelectElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(target),
      "value",
    )?.set;
    setter?.call(target, value);
    target.dispatchEvent(new Event("change", { bubbles: true }));
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("AutomationPolicyView", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    act(() => root.unmount());
    container.remove();
  });

  async function render(
    rules: AutomationUiRule[],
    props: Partial<React.ComponentProps<typeof AutomationPolicyView>> = {},
  ) {
    await act(async () => {
      root.render(
        <AutomationUiHostProvider host={host}>
          <AutomationPolicyView rules={rules} runs={[]} {...props} />
        </AutomationUiHostProvider>,
      );
    });
  }

  it("selects multiple policies, protects dirty drafts, and keeps a create entry in the editor", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await render([
      rule("rule-1", "First policy"),
      rule("rule-2", "Second policy"),
    ]);

    const selector = element("automation-policy-selector") as HTMLSelectElement;
    expect(Array.from(selector.options).map((option) => option.text)).toEqual([
      "First policy",
      "Second policy",
    ]);

    await change("automation-policy-name", "Unsaved first policy");
    await click("automation-create-policy");

    expect((element("automation-policy-name") as HTMLInputElement).value).toBe(
      "Unsaved first policy",
    );

    await change("automation-policy-selector", "rule-2");

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenLastCalledWith(
      "This policy has unsaved changes. Discard them and continue?",
    );
    expect((element("automation-policy-name") as HTMLInputElement).value).toBe(
      "Unsaved first policy",
    );

    confirm.mockReturnValue(true);
    await change("automation-policy-selector", "rule-2");
    expect((element("automation-policy-name") as HTMLInputElement).value).toBe(
      "Second policy",
    );

    await click("automation-create-policy");
    expect(
      (element("automation-policy-selector") as HTMLSelectElement).value,
    ).toMatch(/^draft-/);
    expect((element("automation-policy-name") as HTMLInputElement).value).toBe(
      "Smart Issue dispatch",
    );
  });

  it("edits weekly weekday and timezone settings before saving", async () => {
    const onSaveRule = vi.fn(async (draft: AutomationUiRule) => ({
      ...draft,
      persisted: true,
    }));
    await render([rule("rule-1", "Scheduled policy")], { onSaveRule });

    await click("automation-trigger-schedule");
    await change("automation-schedule-frequency", "weekly");
    await change("automation-schedule-weekday", "friday");
    await change("automation-schedule-timezone", "UTC");
    await change("automation-schedule-time", "16:30");
    await click("automation-save-policy");

    expect(onSaveRule).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: expect.objectContaining({
          type: "schedule",
          schedule: {
            frequency: "weekly",
            weekday: "friday",
            time: "16:30",
            timezone: "UTC",
          },
        }),
      }),
    );
  });

  it("adds, edits, removes, and saves executable workflow steps", async () => {
    const onSaveRule = vi.fn(async (draft: AutomationUiRule) => ({
      ...draft,
      persisted: true,
    }));
    await render([rule("rule-1", "Dynamic policy")], {
      onSaveRule,
      projectAgents,
    });

    await click("automation-empty-add-workflow-step");
    await change("automation-workflow-step-name-0", "Interaction design");
    await change(
      "automation-workflow-step-description-0",
      "Deliver a verified interaction prototype",
    );
    await click("automation-add-workflow-step");
    await change("automation-workflow-step-name-1", "Implementation");
    await click("automation-workflow-step-0");
    await click("automation-remove-workflow-step-0");
    await click("automation-workflow-step-0");
    await change("automation-workflow-step-agent-0", "agent-codex");
    await click("automation-save-policy");

    expect(onSaveRule).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            kind: "dynamic",
            subgraph: {
              nodes: [
                expect.objectContaining({
                  name: "Implementation",
                  kind: "task",
                  dependencies: [],
                  dependencyContext: {},
                  requiredAssigneeType: "agent",
                  requiredAssigneeId: "agent-codex",
                  executionConfig: null,
                  executionConfigOverride: false,
                }),
              ],
            },
          }),
        ],
      }),
    );
  });

  it("saves Claude then Codex as a real linear dependency chain", async () => {
    const onSaveRule = vi.fn(async (draft: AutomationUiRule) => ({
      ...draft,
      persisted: true,
    }));
    await render([rule("rule-1", "Two-step policy")], {
      onSaveRule,
      projectAgents,
    });

    await click("automation-empty-add-workflow-step");
    await change("automation-workflow-step-name-0", "Claude");
    await change("automation-workflow-step-agent-0", "agent-claude");
    await click("automation-add-workflow-step");
    await change("automation-workflow-step-name-1", "Codex");
    await change("automation-workflow-step-agent-1", "agent-codex");

    expect(element("automation-workflow-steps")).toBeTruthy();
    expect(element("automation-workflow-step-0")).toBeTruthy();
    expect(element("automation-workflow-step-1")).toBeTruthy();

    await click("automation-save-policy");
    await flush();

    const savedSteps = onSaveRule.mock.calls[0]?.[0].steps[0]?.subgraph?.nodes;
    expect(savedSteps).toHaveLength(2);
    expect(savedSteps?.[0]).toMatchObject({
      name: "Claude",
      dependencies: [],
      dependencyContext: {},
      requiredAssigneeType: "agent",
      requiredAssigneeId: "agent-claude",
      executionConfig: null,
      executionConfigOverride: false,
    });
    expect(savedSteps?.[1]).toMatchObject({
      name: "Codex",
      dependencies: [savedSteps[0]?.id],
      dependencyContext: {
        [savedSteps[0]!.id]: ["final_result", "deliveries"],
      },
      requiredAssigneeType: "agent",
      requiredAssigneeId: "agent-codex",
      executionConfig: null,
      executionConfigOverride: false,
    });

    const savedRule = onSaveRule.mock.calls[0]![0];
    await render([{ ...savedRule, persisted: true }], {
      onSaveRule,
      projectAgents,
    });
    await click("automation-workflow-step-1");
    expect(
      (element("automation-workflow-step-agent-1") as HTMLSelectElement).value,
    ).toBe("agent-codex");
    await click("automation-workflow-step-0");
    expect(
      (element("automation-workflow-step-agent-0") as HTMLSelectElement).value,
    ).toBe("agent-claude");
  });

  it("requires every configured workflow step to select an agent", async () => {
    const onSaveRule = vi.fn();
    await render([rule("rule-1", "Incomplete policy")], {
      onSaveRule,
      projectAgents,
    });

    await click("automation-empty-add-workflow-step");
    await click("automation-save-policy");

    expect(onSaveRule).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Choose an execution agent for step 1",
    );
  });

  it("ignores a save result invalidated by an automation scope change", async () => {
    let resolveSave: ((value: AutomationUiRule | null) => void) | undefined;
    const onSaveRule = vi.fn(
      () =>
        new Promise<AutomationUiRule | null>((resolve) => {
          resolveSave = resolve;
        }),
    );
    await render([rule("rule-1", "Scoped policy")], { onSaveRule });

    await change("automation-policy-name", "Unsaved scope");
    act(() => {
      element("automation-save-policy").click();
    });
    await render([rule("rule-2", "Current scope")], { onSaveRule });
    await act(async () => {
      resolveSave?.(null);
    });

    expect(onSaveRule).toHaveBeenCalledOnce();
    expect((element("automation-policy-name") as HTMLInputElement).value).toBe(
      "Current scope",
    );
  });

  it("keeps the current policy and reports an error when deletion fails", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onDeleteRule = vi.fn(async () => {
      throw new Error("Delete request failed");
    });
    await render([rule("rule-1", "Protected policy")], { onDeleteRule });

    await click("automation-delete-policy");

    expect(onDeleteRule).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rule-1" }),
    );
    expect(
      (element("automation-policy-selector") as HTMLSelectElement).value,
    ).toBe("rule-1");
    expect((element("automation-policy-name") as HTMLInputElement).value).toBe(
      "Protected policy",
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Delete request failed",
    );
  });
});
