import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  automationLegacyMessageAliases,
  automationMessages,
  translateAutomationMessage,
} from "./messages";

const SOURCE_FILES = [
  "AutomationRulesView.jsx",
  "AutomationWorkflowCanvas.jsx",
  "ProjectAutomationRulesView.tsx",
  "EventSubscriptionManager.tsx",
] as const;

function sourceText(source: (typeof SOURCE_FILES)[number]): string {
  return readFileSync(fileURLToPath(new URL(source, import.meta.url)), "utf8");
}

function visibleSource(content: string): string {
  return content
    .replace(/\/\^[^\n]+\/[a-z]*/g, "")
    .replace(/\.replace\(\/[^\n]+/g, "");
}

function staticTranslationKeys(content: string): string[] {
  return Array.from(
    content.matchAll(/\bt\(\s*["']([^"']+)["']/g),
    (match) => match[1],
  ).filter((key) => key.includes("."));
}

describe("automation visible localization", () => {
  it("keeps visible Han text out of shared automation sources", () => {
    for (const source of SOURCE_FILES) {
      expect(visibleSource(sourceText(source)), source).not.toMatch(
        /\p{Script=Han}/u,
      );
    }
  });

  it("resolves every statically referenced UI key in both locales", () => {
    const keys = new Set(
      SOURCE_FILES.flatMap((source) =>
        staticTranslationKeys(sourceText(source)),
      ),
    );

    for (const key of keys) {
      const sharedKey = automationLegacyMessageAliases[key] ?? key;
      expect(automationMessages.en, `missing en key: ${key}`).toHaveProperty(
        sharedKey,
      );
      expect(
        automationMessages["zh-CN"],
        `missing zh-CN key: ${key}`,
      ).toHaveProperty(sharedKey);
      expect(translateAutomationMessage("en", key)).not.toMatch(
        /\p{Script=Han}/u,
      );
      expect(translateAutomationMessage("en", key)).not.toBe(key);
      expect(translateAutomationMessage("zh-CN", key)).not.toBe(key);
    }
  });

  it("keeps the complete English visible catalog free of Han and raw keys", () => {
    for (const [key, message] of Object.entries(automationMessages.en)) {
      expect(message, key).not.toMatch(/\p{Script=Han}/u);
      expect(message, key).not.toMatch(
        /\b(?:todo|workbench|automation)\.[a-z_]/,
      );
    }
  });
});
