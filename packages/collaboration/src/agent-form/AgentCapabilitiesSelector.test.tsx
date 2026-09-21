// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentCapabilitiesSelector } from "./AgentCapabilitiesSelector";

const labels = {
  add: "Add",
  loadingPlugins: "Loading plugins",
  loadingSkills: "Loading skills",
  noneSelected: "None selected",
  noPlugins: "No plugins",
  noSkills: "No skills",
  plugins: "Plugins",
  pluginsUnavailable: "Plugins unavailable",
  remove: "Remove",
  fromPrompt: "From prompt",
  sourceCloud: "Cloud",
  sourceLocal: "Local",
  sourceLocalCloud: "Local and cloud",
  searchPlugins: "Search plugins",
  searchSkills: "Search skills",
  skills: "Skills",
};

describe("AgentCapabilitiesSelector", () => {
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

  async function click(testId: string) {
    const target = container.querySelector<HTMLElement>(
      `[data-testid="${testId}"]`,
    );
    expect(target).not.toBeNull();
    await act(async () => {
      target!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("closes a capability picker after selecting an option", async () => {
    const onSkillChange = vi.fn();
    await act(async () => {
      root.render(
        <AgentCapabilitiesSelector
          busy={false}
          labels={labels}
          loadingPlugins={false}
          loadingSkills={false}
          onPluginChange={vi.fn()}
          onSkillChange={onSkillChange}
          plugins={[
            {
              displayName: "DingTalk",
              id: "dingtalk@wework",
              marketplaceId: "wework",
              pluginName: "dingtalk",
            },
          ]}
          selectedPluginIds={new Set()}
          selectedSkillKeys={new Set()}
          skillKey={(skill) => `${skill.namespace}/${skill.name}`}
          skills={[
            {
              displayName: "Interactive",
              id: 1,
              name: "interactive",
              namespace: "default",
            },
          ]}
          testIdPrefix="agent"
        />,
      );
    });

    await click("agent-skills-add");
    expect(
      container.querySelector('[data-testid="agent-skills-picker"]'),
    ).not.toBeNull();

    await click("agent-skill-1");

    expect(onSkillChange).toHaveBeenCalledWith(
      expect.objectContaining({ name: "interactive" }),
      true,
    );
    expect(
      container.querySelector('[data-testid="agent-skills-picker"]'),
    ).toBeNull();

    await click("agent-plugins-add");
    expect(
      container.querySelector('[data-testid="agent-plugins-picker"]'),
    ).not.toBeNull();
  });
});
