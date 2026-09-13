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

describe("AutomationPolicyView", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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
