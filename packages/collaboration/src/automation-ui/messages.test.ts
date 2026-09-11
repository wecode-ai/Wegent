import { describe, expect, it } from "vitest";

import {
  automationMessages,
  translateAutomationMessage,
  type AutomationUiLocale,
} from "./messages";

const KEY_INTERFACE_MESSAGES = [
  "automation.title",
  "automation.home.description",
  "automation.create",
  "automation.templateStore.title",
  "automation.templateStore.workflow",
  "automation.runs.title",
  "automation.editor.workflow",
  "automation.editor.settings",
  "automation.rule.trigger",
  "automation.node.dynamic",
  "automation.node.branch",
  "automation.node.loop",
  "automation.execution.select",
  "automation.deliverable.codeSnapshot",
  "automation.status.failed",
  "automation.trigger.webhook",
] as const;

function renderKeyInterface(locale: AutomationUiLocale): string {
  return KEY_INTERFACE_MESSAGES.map((key) =>
    translateAutomationMessage(locale, key, {
      count: 2,
      name: "Device",
    }),
  ).join(" ");
}

describe("automation shared messages", () => {
  it("renders the key automation interfaces in English without Han text", () => {
    const rendered = renderKeyInterface("en");

    expect(rendered).not.toMatch(/\p{Script=Han}/u);
    expect(rendered).not.toMatch(/\bautomation\.[a-z_]/);
    expect(rendered).not.toContain("todo.");
    expect(rendered).not.toContain("workbench.");
  });

  it("renders the key automation interfaces in Chinese without leaking keys", () => {
    const rendered = renderKeyInterface("zh-CN");

    expect(rendered).toMatch(/\p{Script=Han}/u);
    expect(rendered).not.toMatch(/\bautomation\.[a-z_]/);
    expect(rendered).not.toContain("todo.");
    expect(rendered).not.toContain("workbench.");
  });

  it("keeps the English and Chinese catalogs structurally aligned", () => {
    expect(Object.keys(automationMessages.en).sort()).toEqual(
      Object.keys(automationMessages["zh-CN"]).sort(),
    );
  });

  it("resolves legacy Wework keys from the shared catalog", () => {
    expect(
      translateAutomationMessage(
        "en",
        "todo.automation_trigger_schedule_label",
      ),
    ).toBe("Schedule");
    expect(
      translateAutomationMessage(
        "zh-CN",
        "workbench.board_automation_run_started",
      ),
    ).toBe("自动化已开始运行");
  });
});
