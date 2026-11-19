// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from 'vitest'
import { builtinCollaborationTemplates, localizeBuiltinTemplateRecord } from './builtins'

const contentFields = new Set([
  'displayName',
  'description',
  'name',
  'instructions',
  'responsibility',
  'systemPrompt',
  'capabilityDescription',
  'deliverables',
  'acceptance',
  'tags',
])

it.each(builtinCollaborationTemplates())(
  'localizes $document.metadata.name content without changing its execution contract',
  record => {
    const original = structuredClone(record)
    const localized = localizeBuiltinTemplateRecord(record, 'en')
    const compare = (left: unknown, right: unknown, path: string[]) => {
      if (left && typeof left === 'object') {
        expect(Object.keys(right as object)).toEqual(Object.keys(left))
        for (const [key, value] of Object.entries(left)) {
          compare(value, (right as Record<string, unknown>)[key], [...path, key])
        }
      } else if (left !== right) {
        expect(path).not.toContain('metadata')
        expect(path.some(key => contentFields.has(key))).toBe(true)
        expect(typeof right).toBe('string')
        expect(right).not.toMatch(/[\u3400-\u9fff]/)
      }
    }
    compare(record, localized, [])
    expect(localized.document.spec.displayName).not.toBe(record.document.spec.displayName)
    expect(JSON.stringify(localized.document)).not.toMatch(/[\u3400-\u9fff]/)
    const resources = localized.document.spec.resources.collaboration
    expect(resources.project.name).not.toBe(
      record.document.spec.resources.collaboration.project.name
    )
    for (const group of resources.groups) {
      expect(group.instructions).toContain('human confirmation')
      for (const role of group.roles) {
        const agent = resources.agents.find(item => item.key === role.agentKey)
        if (agent) expect(agent.name).toBe(role.name)
      }
    }
    expect(record).toEqual(original)
    expect(localizeBuiltinTemplateRecord(record, 'zh-CN')).toBe(record)
  }
)

it('leaves personal, third-party and unknown releases unchanged', () => {
  for (const patch of [{ source: 'personal' as const }, { ownerId: 7 }]) {
    const record = { ...builtinCollaborationTemplates()[0], ...patch }
    expect(localizeBuiltinTemplateRecord(record, 'en')).toBe(record)
  }
  for (const field of ['namespace', 'name', 'version'] as const) {
    const record = structuredClone(builtinCollaborationTemplates()[0])
    if (field === 'version') record.document.spec.version = '9.0.0'
    else record.document.metadata[field] = 'unknown'
    expect(localizeBuiltinTemplateRecord(record, 'en')).toBe(record)
  }
})
