import { describe, expect, it } from 'vitest'
import { builtinCollaborationTemplates } from './builtins'
import {
  bindTemplate,
  exportTemplate,
  importTemplate,
  templateFromProject,
  validateTemplate,
} from './document'
import type { CollaborationGroup } from '../types'

describe('portable collaboration templates', () => {
  it('ships the complete product lifecycle and round-trips through YAML', () => {
    const document = builtinCollaborationTemplates()[0].document
    expect(document.spec.resources.collaboration.groups[0].roles).toHaveLength(6)
    expect(document.spec.resources.collaboration.groups[0].stages.map(stage => stage.name)).toEqual(
      ['产品定义', '体验设计', '技术方案', '研发实现', '测试验收', '发布交付']
    )
    expect(importTemplate(exportTemplate(document))).toEqual(document)
  })

  it('rejects duplicate YAML keys, aliases, ownership, credentials and dangling roles', () => {
    expect(() => importTemplate('kind: Template\nkind: Ghost')).toThrow()
    expect(() => importTemplate('x: &x [1]\ny: *x')).toThrow()
    const document = structuredClone(builtinCollaborationTemplates()[0].document)
    expect(() => validateTemplate({ ...document, user_id: 7 })).toThrow()
    document.spec.resources.collaboration.groups[0].stages[0].ownerRole = 'missing'
    expect(() => validateTemplate(document)).toThrow()
    expect(() => importTemplate('x'.repeat(1024 * 1024 + 1))).toThrow('file_size')
  })

  it('binds only explicitly selected identities and preserves the coordinator invariant', () => {
    const document = builtinCollaborationTemplates()[0].document
    const group = document.spec.resources.collaboration.groups[0]
    expect(() => bindTemplate(document, {})).toThrow('unbound_roles')
    const selected = Object.fromEntries(
      group.roles.map((role, index) => [
        role.key,
        {
          kind: index === 0 ? ('human' as const) : ('agent' as const),
          id: String(index + 1),
          name: `Member ${index}`,
          responsibility: '',
        },
      ])
    )
    const drafts = bindTemplate(document, { [group.key]: selected })
    expect(drafts[0].members).toHaveLength(6)
    expect(drafts[0].stages[0].assignee?.id).toBe('2')
    selected[group.roles[1].key] = selected[group.leaderRole]
    expect(() => bindTemplate(document, { [group.key]: selected })).toThrow('leader_executor')
  })

  it('exports all project groups without original users, agents, tasks or credentials', () => {
    const group = {
      name: 'Delivery',
      description: 'Goal',
      instructions: 'Coordinate and review',
      leader: { kind: 'human', id: 'secret-user', responsibility: '' },
      members: [
        { kind: 'human', id: 'secret-user', responsibility: '' },
        { kind: 'agent', id: 'secret-agent', responsibility: 'Implement' },
      ],
      stages: [
        {
          id: 'implementation',
          name: 'Implement',
          description: 'Verify acceptance',
          assignee: {
            kind: 'agent',
            id: 'secret-agent',
            responsibility: 'Implement',
          },
        },
      ],
      execution_requirements: { required_tags: ['macos'] },
    } as CollaborationGroup
    const template = templateFromProject(
      { name: 'Project', description: 'Goal' },
      [group, { ...group, name: 'Review' }],
      'portable-example'
    )
    const yaml = exportTemplate(template)
    expect(template.spec.resources.collaboration.groups).toHaveLength(2)
    expect(yaml).not.toContain('secret-user')
    expect(yaml).not.toContain('secret-agent')
    expect(template.spec.resources.collaboration.groups[0].stages[0].ownerRole).toBe('role-1')
    expect(
      template.spec.resources.collaboration.groups[0].executionRequirements.requiredTags
    ).toEqual(['macos'])
  })
})
