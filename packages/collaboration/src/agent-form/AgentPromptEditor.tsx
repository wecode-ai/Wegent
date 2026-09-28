// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  LocalDeviceApp,
  LocalDeviceSkill,
} from "@wegent/chat-core/runtime-composer-catalog";
import { useMemo, useRef } from "react";

import { ComposerAutocompleteInput } from "../composer/ComposerAutocompleteInput";
import type { CollaborationTranslate } from "../i18n";
import type { AgentCapabilitySkill } from "./AgentCapabilitiesSelector";
import type { AgentFormField } from "./AgentFormDialog";
import type { UnifiedAgentPluginRef } from "./types";

export function AgentPromptEditor({
  busy,
  field,
  plugins,
  skills,
  translate,
}: {
  busy: boolean;
  field: AgentFormField;
  plugins: UnifiedAgentPluginRef[];
  skills: AgentCapabilitySkill[];
  translate: CollaborationTranslate;
}) {
  const editorRef = useRef<HTMLElement | null>(null);
  const composerSkills = useMemo(() => skills.map(toComposerSkill), [skills]);
  const composerPlugins = useMemo(
    () => plugins.map(toComposerPlugin),
    [plugins],
  );

  return (
    <label className="block space-y-1.5 text-sm text-text-secondary">
      <span>{field.label}</span>
      <ComposerAutocompleteInput
        canSend={false}
        className="min-h-24 max-h-48 overflow-y-auto rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-text-primary shadow-sm outline-none transition-[border-color,box-shadow] placeholder:text-text-muted focus:border-focus focus:ring-2 focus:ring-focus/15"
        disabled={busy || field.disabled}
        onChange={field.onChange}
        onListLocalApps={async () => composerPlugins}
        onListLocalSkills={async () => composerSkills}
        onSubmit={() => undefined}
        placeholder={field.placeholder ?? ""}
        rows={5}
        sendKey="cmd_enter"
        skillMenuClassName="bottom-full left-0 mb-2 w-full"
        testId={field.testId}
        textareaRef={editorRef}
        translate={translate}
        value={field.value}
      />
    </label>
  );
}

export function resolveAgentPromptCapabilityReferences(
  value: string,
  plugins: UnifiedAgentPluginRef[],
  skills: AgentCapabilitySkill[],
): {
  pluginIds: Set<string>;
  skillIds: Set<number>;
  skillKeys: Set<string>;
} {
  const pluginIds = new Set<string>();
  const skillKeys = new Set<string>();
  const skillIds = new Set<number>();

  for (const match of value.matchAll(/\[\$[^\]]+]\(([^)\n]+)\)/g)) {
    const href = match[1] ?? "";
    if (href.startsWith("plugin://")) {
      const identity = href.slice("plugin://".length);
      const separator = identity.lastIndexOf("@");
      const pluginName = identity.slice(0, separator);
      const marketplaceId = identity.slice(separator + 1);
      const plugin = plugins.find(
        (candidate) =>
          candidate.pluginName === pluginName &&
          candidate.marketplaceId === marketplaceId,
      );
      if (plugin) pluginIds.add(plugin.id);
      continue;
    }
    if (href.startsWith("app://")) {
      const plugin = plugins.find(
        (candidate) => candidate.id === href.slice("app://".length),
      );
      if (plugin) pluginIds.add(plugin.id);
      continue;
    }
    if (!href.startsWith("skill:///") || !href.endsWith("/SKILL.md")) continue;
    const path = href.slice("skill:///".length, -"/SKILL.md".length);
    const separator = path.indexOf("/");
    if (separator <= 0) continue;
    const namespace = path.slice(0, separator);
    const name = path.slice(separator + 1);
    const skill = skills.find(
      (candidate) =>
        candidate.name === name &&
        (candidate.namespace || "default") === namespace,
    );
    if (skill) {
      skillKeys.add(agentPromptSkillKey(skill));
      skillIds.add(skill.id);
    }
  }

  return { pluginIds, skillIds, skillKeys };
}

export function agentPromptSkillKey(skill: AgentCapabilitySkill): string {
  return `${skill.namespace || "default"}:${skill.name}`;
}

function toComposerSkill(skill: AgentCapabilitySkill): LocalDeviceSkill {
  const namespace = skill.namespace || "default";
  return {
    name: skill.name,
    description: skill.displayName || skill.name,
    path: `skill:///${namespace}/${skill.name}/SKILL.md`,
    source: "agents",
    scope: "system",
    source_label: namespace,
    origin: "wegent",
  };
}

function toComposerPlugin(plugin: UnifiedAgentPluginRef): LocalDeviceApp {
  return {
    id: plugin.id,
    name: plugin.displayName || plugin.pluginName,
    pluginKey: plugin.pluginName,
    description: plugin.description || plugin.marketplaceId,
    isAccessible: true,
    isEnabled: true,
    source: "codex-app",
    skillPath: `plugin://${plugin.pluginName}@${plugin.marketplaceId}`,
  };
}
