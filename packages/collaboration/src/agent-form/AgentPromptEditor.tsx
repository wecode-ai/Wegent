// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { LocalDeviceApp, LocalDeviceSkill } from '@wegent/chat-core/runtime-composer-catalog'
import { useCallback, useMemo, useRef } from 'react'

import { ComposerAutocompleteInput } from '../composer/ComposerAutocompleteInput'
import type { CollaborationTranslate } from '../i18n'
import type { AgentCapabilitySkill } from './AgentCapabilitiesSelector'
import type { AgentFormField } from './AgentFormDialog'
import type { UnifiedAgentPluginRef } from './types'

export function AgentPromptEditor({
  busy,
  field,
  onFocus,
  plugins,
  skills,
  translate,
}: {
  busy: boolean
  field: AgentFormField
  onFocus?(): void
  plugins: UnifiedAgentPluginRef[]
  skills: AgentCapabilitySkill[]
  translate: CollaborationTranslate
}) {
  const editorRef = useRef<HTMLElement | null>(null)
  const composerSkills = useMemo(() => skills.map(toComposerSkill), [skills])
  const composerPlugins = useMemo(() => plugins.map(toComposerPlugin), [plugins])
  const listSkills = useCallback(async () => composerSkills, [composerSkills])
  const listPlugins = useCallback(async () => composerPlugins, [composerPlugins])

  return (
    <label className="block space-y-1.5 text-sm text-text-secondary" onFocus={onFocus}>
      <span>{field.label}</span>
      <ComposerAutocompleteInput
        canSend={false}
        className="min-h-24 max-h-48 overflow-y-auto rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-text-primary shadow-sm outline-none transition-[border-color,box-shadow] placeholder:text-text-muted keyboard:focus:border-focus keyboard:focus:ring-2 keyboard:focus:ring-focus/15"
        disabled={busy || field.disabled}
        onChange={field.onChange}
        onListLocalApps={listPlugins}
        onListLocalSkills={listSkills}
        onSubmit={() => undefined}
        placeholder={field.placeholder ?? ''}
        rows={5}
        sendKey="cmd_enter"
        skillMenuClassName="w-[var(--anchor-width)]"
        testId={field.testId}
        textareaRef={editorRef}
        translate={translate}
        value={field.value}
      />
    </label>
  )
}

function toComposerSkill(skill: AgentCapabilitySkill): LocalDeviceSkill {
  const namespace = skill.namespace || 'default'
  return {
    name: skill.name,
    description: skill.displayName || skill.name,
    path: `skill:///${namespace}/${skill.name}/SKILL.md`,
    source: 'agents',
    scope: 'system',
    source_label: namespace,
    origin: 'wegent',
  }
}

function toComposerPlugin(plugin: UnifiedAgentPluginRef): LocalDeviceApp {
  return {
    id: plugin.id,
    name: plugin.displayName || plugin.pluginName,
    pluginKey: plugin.pluginName,
    description: plugin.description || plugin.marketplaceId,
    isAccessible: true,
    isEnabled: true,
    source: 'codex-app',
    skillPath: `plugin://${plugin.pluginName}@${plugin.marketplaceId}`,
  }
}
