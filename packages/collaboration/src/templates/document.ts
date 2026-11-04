// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { parseDocument, stringify } from 'yaml'
import type { CollaborationGroup, CollaborationGroupMember, CollaborationProject } from '../types'
import type { ProjectCreateCollaborationGroupDraft } from '../project-create/types'
import type { CollaborationLocale } from '../i18n'
import type { WorkspaceProjectAgent } from '../ports/SharedWorkspaceApi'
import type { CollaborationTemplate, TemplateRoleAssignments, TemplateGroup } from './types'
import { isTagNameTooLong } from '../tagging'
import { defaultBoardViewId } from '../project-board/projectBoardViews'

const MAX_FILE_BYTES = 1024 * 1024
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/

function object(value: unknown, path: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(path)
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !keys.includes(key))) throw new Error(path)
  return result
}

function text(value: unknown, path: string, required = true, max = 20000): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new Error(path)
  }
  return value
}

function key(value: unknown, path: string): string {
  const result = text(value, path, true, 100)
  if (!ID.test(result)) throw new Error(path)
  return result
}

function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(path)
  return value
}

function unique(values: string[], path: string): void {
  if (new Set(values).size !== values.length) throw new Error(path)
}

function group(value: unknown, index: number): TemplateGroup {
  const path = `groups[${index}]`
  const item = object(value, path, [
    'key',
    'name',
    'description',
    'instructions',
    'leaderRole',
    'roles',
    'stages',
    'executionRequirements',
  ])
  const roles = array(item.roles, `${path}.roles`, 50).map((value, index) => {
    const role = object(value, `${path}.roles[${index}]`, [
      'key',
      'name',
      'responsibility',
      'defaultKind',
      'agentKey',
    ])
    if (
      role.defaultKind !== undefined &&
      role.defaultKind !== 'human' &&
      role.defaultKind !== 'agent'
    )
      throw new Error(`${path}.role.defaultKind`)
    return {
      key: key(role.key, `${path}.role.key`),
      name: text(role.name, `${path}.role.name`, true, 200),
      responsibility: text(role.responsibility, `${path}.role.responsibility`, false),
      ...(role.agentKey === undefined
        ? {}
        : { agentKey: key(role.agentKey, `${path}.role.agentKey`) }),
      ...(role.defaultKind ? { defaultKind: role.defaultKind as 'human' | 'agent' } : {}),
    }
  })
  if (!roles.length) throw new Error(`${path}.roles`)
  unique(
    roles.map(role => role.key),
    `${path}.roles`
  )
  const roleKeys = new Set(roles.map(role => role.key))
  const leaderRole = key(item.leaderRole, `${path}.leaderRole`)
  if (!roleKeys.has(leaderRole)) throw new Error(`${path}.leaderRole`)
  const stages = array(item.stages, `${path}.stages`, 100).map((value, index) => {
    const stage = object(value, `${path}.stages[${index}]`, [
      'key',
      'name',
      'description',
      'ownerRole',
      'deliverables',
      'acceptance',
    ])
    const ownerRole =
      stage.ownerRole === null ? null : key(stage.ownerRole, `${path}.stage.ownerRole`)
    if (ownerRole !== null && (!roleKeys.has(ownerRole) || ownerRole === leaderRole))
      throw new Error(`${path}.stage.ownerRole`)
    return {
      key: key(stage.key, `${path}.stage.key`),
      name: text(stage.name, `${path}.stage.name`, true, 200),
      description: text(stage.description, `${path}.stage.description`, false),
      ownerRole,
      deliverables: array(stage.deliverables, `${path}.stage.deliverables`, 30).map(value =>
        text(value, `${path}.stage.deliverable`, true, 2000)
      ),
      acceptance: text(stage.acceptance, `${path}.stage.acceptance`, false),
    }
  })
  unique(
    stages.map(stage => stage.key),
    `${path}.stages`
  )
  const requirements = object(item.executionRequirements, `${path}.executionRequirements`, [
    'requiredTags',
  ])
  return {
    key: key(item.key, `${path}.key`),
    name: text(item.name, `${path}.name`, true, 200),
    description: text(item.description, `${path}.description`, false),
    instructions: text(item.instructions, `${path}.instructions`, false),
    leaderRole,
    roles,
    stages,
    executionRequirements: {
      requiredTags: array(requirements.requiredTags, `${path}.requiredTags`, 30).map(value =>
        text(value, `${path}.requiredTag`, true, 100)
      ),
    },
  }
}

/** Whitelist the portable schema: credentials, ownership and live bindings are rejected. */
export function validateTemplate(value: unknown): CollaborationTemplate {
  const root = object(value, 'document', ['apiVersion', 'kind', 'metadata', 'spec'])
  if (root.apiVersion !== 'agent.wecode.io/v1' || root.kind !== 'Template')
    throw new Error('apiVersion/kind')
  const metadata = object(root.metadata, 'metadata', ['name', 'namespace'])
  const spec = object(root.spec, 'spec', [
    'category',
    'displayName',
    'description',
    'version',
    'resources',
  ])
  if (spec.category !== 'collaboration') throw new Error('spec.category')
  const resources = object(spec.resources, 'resources', ['collaboration'])
  const collaboration = object(resources.collaboration, 'collaboration', [
    'project',
    'groups',
    'agents',
  ])
  const project = object(collaboration.project, 'project', [
    'name',
    'description',
    'taskAssignment',
    'board',
  ])
  const agents =
    collaboration.agents === undefined
      ? undefined
      : array(collaboration.agents, 'agents', 100).map(value => {
          const agent = object(value, 'agent', [
            'key',
            'name',
            'runtime',
            'systemPrompt',
            'capabilityDescription',
            'executionMode',
            'workspacePolicy',
            'maxConcurrentExecutions',
          ])
          if (agent.runtime !== 'codex' && agent.runtime !== 'claude_code')
            throw new Error('agent.runtime')
          if (
            agent.executionMode !== undefined &&
            agent.executionMode !== 'auto' &&
            agent.executionMode !== 'manual_approval'
          )
            throw new Error('agent.executionMode')
          if (
            agent.workspacePolicy !== undefined &&
            agent.workspacePolicy !== 'project' &&
            agent.workspacePolicy !== 'git_worktree'
          )
            throw new Error('agent.workspacePolicy')
          if (
            agent.maxConcurrentExecutions !== undefined &&
            (!Number.isInteger(agent.maxConcurrentExecutions) ||
              Number(agent.maxConcurrentExecutions) < 1 ||
              Number(agent.maxConcurrentExecutions) > 20)
          )
            throw new Error('agent.maxConcurrentExecutions')
          return {
            ...(agent.executionMode
              ? { executionMode: agent.executionMode as 'auto' | 'manual_approval' }
              : {}),
            ...(agent.workspacePolicy
              ? { workspacePolicy: agent.workspacePolicy as 'project' | 'git_worktree' }
              : {}),
            ...(agent.maxConcurrentExecutions === undefined
              ? {}
              : { maxConcurrentExecutions: Number(agent.maxConcurrentExecutions) }),
            key: key(agent.key, 'agent.key'),
            name: text(agent.name, 'agent.name', true, 100),
            runtime: agent.runtime as 'codex' | 'claude_code',
            systemPrompt: text(agent.systemPrompt, 'agent.systemPrompt', false),
            capabilityDescription: text(
              agent.capabilityDescription,
              'agent.capabilityDescription',
              false,
              2000
            ),
          }
        })
  unique(agents?.map(agent => agent.key) ?? [], 'agents.key')
  const groups = array(collaboration.groups, 'groups', 10).map(group)
  unique(
    groups.map(group => group.key),
    'groups.key'
  )
  unique(
    groups.map(group => group.name.trim()),
    'groups.name'
  )
  for (const group of groups) {
    for (const role of group.roles) {
      if (
        role.agentKey &&
        (role.defaultKind === 'human' || !agents?.some(agent => agent.key === role.agentKey))
      )
        throw new Error('role.agentKey')
    }
  }
  const settings: Partial<CollaborationTemplate['spec']['resources']['collaboration']['project']> =
    {}
  if (project.taskAssignment !== undefined) {
    const assignment = object(project.taskAssignment, 'project.taskAssignment', [
      'enabled',
      'groupKey',
      'tags',
      'priorities',
    ])
    if (typeof assignment.enabled !== 'boolean') throw new Error('project.taskAssignment.enabled')
    const groupKey = key(assignment.groupKey, 'project.taskAssignment.groupKey')
    if (!groups.some(group => group.key === groupKey))
      throw new Error('project.taskAssignment.groupKey')
    settings.taskAssignment = { enabled: assignment.enabled, groupKey }
    for (const field of ['tags', 'priorities'] as const) {
      if (assignment[field] !== undefined)
        settings.taskAssignment[field] = array(
          assignment[field],
          `project.taskAssignment.${field}`,
          100
        ).map(value => text(value, `project.taskAssignment.${field}`, true, 100))
    }
  }
  if (project.board !== undefined) {
    const board = object(project.board, 'project.board', ['name', 'tags'])
    const tags = array(board.tags, 'project.board.tags', 100).map(value => {
      const tag = text(value, 'project.board.tag', true, 100).trim()
      if (isTagNameTooLong(tag)) throw new Error('project.board.tag')
      return tag
    })
    if (!tags.length) throw new Error('project.board.tags')
    unique(tags, 'project.board.tags')
    settings.board = {
      name: text(board.name, 'project.board.name', true, 200),
      tags,
    }
  }
  const document: CollaborationTemplate = {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'Template',
    metadata: {
      name: key(metadata.name, 'metadata.name'),
      namespace: key(metadata.namespace, 'metadata.namespace'),
    },
    spec: {
      category: 'collaboration',
      displayName: text(spec.displayName, 'displayName', true, 200),
      description: text(spec.description, 'description', false),
      version: key(spec.version, 'version'),
      resources: {
        collaboration: {
          project: {
            name: text(project.name, 'project.name', true, 200),
            description: text(project.description, 'project.description', false),
            ...settings,
          },
          ...(agents ? { agents } : {}),
          groups,
        },
      },
    },
  }
  if (new TextEncoder().encode(JSON.stringify(document)).length > MAX_FILE_BYTES)
    throw new Error('file_size')
  return document
}

export function importTemplate(yaml: string): CollaborationTemplate {
  if (new TextEncoder().encode(yaml).length > MAX_FILE_BYTES) throw new Error('file_size')
  const parsed = parseDocument(yaml, { uniqueKeys: true, customTags: [] })
  if (parsed.errors.length || parsed.warnings.length) throw new Error('yaml')
  return validateTemplate(parsed.toJS({ maxAliasCount: 0 }))
}

export function exportTemplate(document: CollaborationTemplate): string {
  return stringify(validateTemplate(document))
}

/** Bind roles through an explicit user selection; never infer identity from names. */
export function bindTemplate(
  document: CollaborationTemplate,
  bindings: TemplateRoleAssignments
): ProjectCreateCollaborationGroupDraft[] {
  validateTemplate(document)
  return document.spec.resources.collaboration.groups.map(group => {
    const selected = bindings[group.key] ?? {}
    if (group.roles.some(role => !selected[role.key])) throw new Error('unbound_roles')
    const leader = { ...selected[group.leaderRole], responsibility: '' }
    const memberKey = (member: CollaborationGroupMember) => `${member.kind}:${member.id}`
    const members = new Map<string, CollaborationGroupMember>([[memberKey(leader), leader]])
    for (const role of group.roles) {
      const participant = selected[role.key]
      if (role.key !== group.leaderRole && memberKey(participant) === memberKey(leader))
        throw new Error('leader_executor')
      if (role.key === group.leaderRole) continue
      const existing = members.get(memberKey(participant))
      members.set(memberKey(participant), {
        ...participant,
        responsibility: [existing?.responsibility, role.responsibility].filter(Boolean).join('\n'),
      })
    }
    const clean = (member: CollaborationGroupMember): CollaborationGroupMember => ({
      kind: member.kind,
      id: member.id,
      ...(member.name ? { name: member.name } : {}),
      responsibility: member.responsibility,
    })
    return {
      name: group.name.trim(),
      description: group.description,
      instructions: group.instructions,
      leader: clean(leader),
      members: [...members.values()].map(clean),
      stages: group.stages.map(stage => ({
        id: stage.key,
        name: stage.name,
        description: [stage.description, ...stage.deliverables, stage.acceptance]
          .filter(Boolean)
          .join('\n'),
        assignee: stage.ownerRole
          ? clean(members.get(memberKey(selected[stage.ownerRole]))!)
          : null,
      })),
      executionRequirements: group.executionRequirements,
    }
  })
}

/** Only configuration enters an export; project tasks and live identities never do. */
export function templateFromProject(
  project: Pick<
    CollaborationProject,
    'name' | 'description' | 'board_views' | 'automatic_processing_rules'
  >,
  groups: CollaborationGroup[],
  name: string,
  locale: CollaborationLocale = 'en',
  projectAgents: WorkspaceProjectAgent[] = []
): CollaborationTemplate {
  const used = new Set(
    groups
      .flatMap(group => [group.leader, ...group.members])
      .filter(member => member.kind === 'agent')
      .map(member => member.id)
  )
  const portable = projectAgents
    .filter(agent => used.has(String(agent.team_id ?? agent.id)))
    .map((agent, index) => ({
      id: String(agent.team_id ?? agent.id),
      key: `agent-${index + 1}`,
      name: agent.name,
      runtime: agent.runtime,
      systemPrompt: agent.systemPrompt ?? '',
      ...(agent.executionMode ? { executionMode: agent.executionMode } : {}),
      ...(agent.workspacePolicy ? { workspacePolicy: agent.workspacePolicy } : {}),
      ...(agent.maxConcurrentExecutions
        ? { maxConcurrentExecutions: agent.maxConcurrentExecutions }
        : {}),
      capabilityDescription:
        typeof agent.capabilityDescription === 'string' ? agent.capabilityDescription : '',
    }))
  const converted = groups.map((group, index): TemplateGroup => {
    const participants = [
      group.leader,
      ...group.members.filter(
        member => member.kind !== group.leader.kind || member.id !== group.leader.id
      ),
    ]
    const roleKey = (member: CollaborationGroupMember) => {
      const index = participants.findIndex(
        candidate => candidate.kind === member.kind && candidate.id === member.id
      )
      if (index < 0) throw new Error('stage_participant')
      return `role-${index}`
    }
    return {
      key: `group-${index + 1}`,
      name: group.name,
      description: group.description,
      instructions: group.instructions ?? '',
      leaderRole: 'role-0',
      roles: participants.map((member, index) => {
        const agent =
          member.kind === 'agent' ? portable.find(agent => agent.id === member.id) : undefined
        return {
          key: `role-${index}`,
          name:
            agent?.name ??
            (index === 0
              ? locale === 'zh-CN'
                ? '小组负责人'
                : 'Coordinator'
              : locale === 'zh-CN'
                ? `协作成员 ${index}`
                : `Contributor ${index}`),
          responsibility: member.responsibility || agent?.capabilityDescription || '',
          defaultKind: member.kind,
          ...(agent ? { agentKey: agent.key } : {}),
        }
      }),
      stages: group.stages.map(stage => ({
        key: stage.id,
        name: stage.name,
        description: stage.description,
        ownerRole: stage.assignee ? roleKey(stage.assignee) : null,
        deliverables: [],
        acceptance: '',
      })),
      executionRequirements: {
        requiredTags: group.execution_requirements?.required_tags ?? [],
      },
    }
  })
  const rules = project.automatic_processing_rules?.filter(
    rule =>
      rule.eventType === 'task.created' &&
      rule.targetKind === 'collaboration_group' &&
      groups.some(group => group.id === rule.targetId)
  )
  const rule = rules?.find(rule => rule.enabled) ?? rules?.[0]
  const targetIndex = rule ? groups.findIndex(group => group.id === rule.targetId) : -1
  const view = project.board_views?.views.find(
    view => view.id === defaultBoardViewId(project.board_views)
  )
  const board =
    view &&
    view.columns.some(column => column.type === 'tag') &&
    view.columns.every(column => column.type === 'tag' || column.type === 'unmatched')
      ? {
          name: view.name,
          tags: view.columns.filter(column => column.type === 'tag').map(column => column.value),
        }
      : undefined
  return validateTemplate({
    apiVersion: 'agent.wecode.io/v1',
    kind: 'Template',
    metadata: { name, namespace: 'default' },
    spec: {
      category: 'collaboration',
      displayName: project.name,
      description: project.description,
      version: '1.0.0',
      resources: {
        collaboration: {
          project: {
            name: project.name,
            description: project.description,
            ...(rule
              ? {
                  taskAssignment: {
                    enabled: rule.enabled,
                    groupKey: converted[targetIndex].key,
                    ...(Array.isArray(rule.eventConfig?.tags)
                      ? { tags: rule.eventConfig.tags }
                      : {}),
                    ...(Array.isArray(rule.eventConfig?.priorities)
                      ? { priorities: rule.eventConfig.priorities }
                      : {}),
                  },
                }
              : {}),
            ...(board ? { board } : {}),
          },
          ...(portable.length ? { agents: portable.map(({ id: _, ...agent }) => agent) } : {}),
          groups: converted,
        },
      },
    },
  })
}

export function downloadTemplate(document: CollaborationTemplate, filename: string): void {
  const url = URL.createObjectURL(
    new Blob([exportTemplate(document)], { type: 'application/yaml;charset=utf-8' })
  )
  const link = window.document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
