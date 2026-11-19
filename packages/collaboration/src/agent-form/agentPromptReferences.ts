// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentCapabilitySkill } from './AgentCapabilitiesSelector'
import type { UnifiedAgentPluginRef } from './types'

export function resolveAgentPromptCapabilityReferences(
  value: string,
  plugins: UnifiedAgentPluginRef[],
  skills: AgentCapabilitySkill[]
): {
  pluginIds: Set<string>
  skillIds: Set<number>
  skillKeys: Set<string>
} {
  const pluginIds = new Set<string>()
  const skillKeys = new Set<string>()
  const skillIds = new Set<number>()

  for (const match of value.matchAll(/\[\$[^\]]+]\(([^)\n]+)\)/g)) {
    const href = match[1] ?? ''
    if (href.startsWith('plugin://')) {
      const identity = href.slice('plugin://'.length)
      const separator = identity.lastIndexOf('@')
      const pluginName = identity.slice(0, separator)
      const marketplaceId = identity.slice(separator + 1)
      const plugin = plugins.find(
        candidate =>
          candidate.pluginName === pluginName && candidate.marketplaceId === marketplaceId
      )
      if (plugin) pluginIds.add(plugin.id)
      continue
    }
    if (href.startsWith('app://')) {
      const plugin = plugins.find(candidate => candidate.id === href.slice('app://'.length))
      if (plugin) pluginIds.add(plugin.id)
      continue
    }
    if (!href.startsWith('skill:///') || !href.endsWith('/SKILL.md')) continue
    const path = href.slice('skill:///'.length, -'/SKILL.md'.length)
    const separator = path.indexOf('/')
    if (separator <= 0) continue
    const namespace = path.slice(0, separator)
    const name = path.slice(separator + 1)
    const skill = skills.find(
      candidate => candidate.name === name && (candidate.namespace || 'default') === namespace
    )
    if (skill) {
      skillKeys.add(agentPromptSkillKey(skill))
      skillIds.add(skill.id)
    }
  }

  return { pluginIds, skillIds, skillKeys }
}

function agentPromptSkillKey(skill: AgentCapabilitySkill): string {
  return `${skill.namespace || 'default'}:${skill.name}`
}
