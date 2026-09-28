// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentCapabilitiesSelector,
  type AgentCapabilitiesLabels,
  type AgentCapabilitySkill,
} from "./AgentCapabilitiesSelector";
import type { UnifiedAgentPluginRef } from "./types";

const labels: AgentCapabilitiesLabels = {
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
const plugin: UnifiedAgentPluginRef = {
  displayName: "Messaging",
  id: "messaging@wework-personal",
  marketplaceId: "wework-personal",
  pluginName: "messaging",
};
const skill: AgentCapabilitySkill = {
  displayName: "Knowledge base",
  id: 1,
  name: "knowledge-base",
  namespace: "default",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function element<T extends HTMLElement>(testId: string): T {
  const result = container.querySelector<T>(`[data-testid="${testId}"]`);
  if (!result) throw new Error(`Missing element ${testId}`);
  return result;
}

function Harness() {
  const [selectedPluginIds, setSelectedPluginIds] = useState(new Set<string>());
  const [selectedSkillKeys, setSelectedSkillKeys] = useState(new Set<string>());

  return (
    <AgentCapabilitiesSelector
      busy={false}
      labels={labels}
      loadingPlugins={false}
      loadingSkills={false}
      onPluginChange={(pluginId, selected) =>
        setSelectedPluginIds(selected ? new Set([pluginId]) : new Set())
      }
      onSkillChange={(selectedSkill, selected) =>
        setSelectedSkillKeys(
          selected ? new Set([selectedSkill.name]) : new Set(),
        )
      }
      plugins={[plugin]}
      selectedPluginIds={selectedPluginIds}
      selectedSkillKeys={selectedSkillKeys}
      skillKey={(selectedSkill) => selectedSkill.name}
      skills={[skill]}
      testIdPrefix="agent"
    />
  );
}

describe("AgentCapabilitiesSelector", () => {
  it("closes each picker after selecting a capability", () => {
    act(() => root.render(<Harness />));

    act(() => element<HTMLButtonElement>("agent-skills-add").click());
    expect(element("agent-skills-picker")).toBeTruthy();

    act(() => element<HTMLInputElement>("agent-skill-1").click());
    expect(
      container.querySelector('[data-testid="agent-skills-picker"]'),
    ).toBeNull();

    act(() => element<HTMLButtonElement>("agent-plugins-add").click());
    expect(element("agent-plugins-picker")).toBeTruthy();

    act(() =>
      element<HTMLInputElement>(
        "agent-plugin-messaging@wework-personal",
      ).click(),
    );
    expect(
      container.querySelector('[data-testid="agent-plugins-picker"]'),
    ).toBeNull();
  });
});
