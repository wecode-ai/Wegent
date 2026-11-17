// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationGroup } from '../types'
import type { CollaborationLocale } from '../i18n'
import type { ProjectCreateCollaborationGroupDraft } from '../project-create/types'
import type { CollaborationTemplate, TemplateRoutingResolver } from './types'
import type {
  TemplateImportBegin,
  TemplateImportContext,
  TemplateImportOperation,
  TemplateImportStepKind,
  TemplateProjectConfigurationOptions,
} from './projectTemplateImportTypes'
import { normalizeCollaborationGroupDraftForPersistence } from '../project-create/collaborationGroupDraft'
import { materializeTemplateAgents, templateAgentCreateInput } from './agents'
import { applyTemplateGroups, TemplateConfigurationError } from './apply'
import { templateFailureMessage, templateMessages } from './messages'
import {
  canonicalTemplateImportJson,
  freezeProjectTemplateImportIntent,
  projectTemplateImportRequest,
  projectTemplateImportRouting,
  readProjectTemplateImportIntent,
  templateImportAutomationStep,
  templateImportBoardStep,
  templateImportStateError,
  type ProjectTemplateImportIntent,
} from './projectTemplateImportIntent'

interface ConfigurationHooks {
  prepare(
    api: SharedWorkspaceApi,
    projectId: string,
    document: CollaborationTemplate,
    locale: CollaborationLocale
  ): Promise<void>
  configure(
    api: SharedWorkspaceApi,
    projectId: string,
    document: CollaborationTemplate,
    groups: CollaborationGroup[],
    locale: CollaborationLocale,
    options?: TemplateProjectConfigurationOptions
  ): Promise<void>
}

export class TemplateImportRetryError extends TemplateConfigurationError {
  readonly retryBlocked = false
  readonly operation: TemplateImportOperation | undefined

  constructor(cause: unknown, locale: CollaborationLocale, operation?: TemplateImportOperation) {
    const completed = operation?.steps.filter(step => step.resourceId).length ?? 0
    const progress =
      completed && operation
        ? locale === 'zh-CN'
          ? ` 已完成 ${completed}/${operation.steps.length} 个导入步骤。`
          : ` ${completed}/${operation.steps.length} import steps are complete.`
        : ''
    const resume =
      locale === 'zh-CN'
        ? '可重新应用相同配置；系统会恢复已保存的导入进度，避免重复创建。'
        : 'Apply the same configuration to resume saved progress without creating duplicates.'
    super(`${templateFailureMessage(cause, locale)}${progress} ${resume}`, { cause })
    this.operation = operation
  }
}

function assertOperation(
  operation: TemplateImportOperation,
  projectId: string,
  request: TemplateImportBegin,
  locale: CollaborationLocale
) {
  if (
    !operation.id ||
    operation.projectId !== projectId ||
    operation.protocolVersion !== 1 ||
    !['pending', 'completed'].includes(operation.status) ||
    !Array.isArray(operation.steps) ||
    canonicalTemplateImportJson(operation.intent) !== canonicalTemplateImportJson(request.intent) ||
    operation.steps.length !== request.steps.length ||
    new Set(operation.steps.map(step => step.key)).size !== request.steps.length ||
    request.steps.some(
      expected =>
        !operation.steps.some(step => step.key === expected.key && step.kind === expected.kind)
    ) ||
    operation.steps.some(
      step =>
        step.resourceId !== undefined && (typeof step.resourceId !== 'string' || !step.resourceId)
    ) ||
    (operation.status === 'completed' && operation.steps.some(step => !step.resourceId))
  )
    throw templateImportStateError(locale)
}

class ImportSession {
  readonly api: SharedWorkspaceApi
  readonly projectId: string
  readonly request: TemplateImportBegin
  readonly locale: CollaborationLocale
  operation: TemplateImportOperation

  constructor(
    api: SharedWorkspaceApi,
    projectId: string,
    request: TemplateImportBegin,
    operation: TemplateImportOperation,
    locale: CollaborationLocale
  ) {
    assertOperation(operation, projectId, request, locale)
    this.api = api
    this.projectId = projectId
    this.request = request
    this.operation = operation
    this.locale = locale
  }

  receipt(key: string) {
    return this.operation.steps.find(step => step.key === key)?.resourceId
  }

  context(key: string): TemplateImportContext {
    return { operationId: this.operation.id, stepKey: key }
  }

  async refresh() {
    const next = await this.api.templateImports!.get(this.projectId, this.operation.id)
    assertOperation(next, this.projectId, this.request, this.locale)
    if (
      next.id !== this.operation.id ||
      this.operation.steps.some(
        step =>
          step.resourceId &&
          next.steps.find(current => current.key === step.key)?.resourceId !== step.resourceId
      )
    )
      throw templateImportStateError(this.locale)
    this.operation = next
  }

  async confirm(key: string, resourceId: string) {
    await this.refresh()
    if (this.receipt(key) !== resourceId) throw templateImportStateError(this.locale)
  }

  async resource<T extends { id: string }>(
    key: string,
    kind: TemplateImportStepKind,
    write: (context: TemplateImportContext) => Promise<T>,
    restore: (id: string) => Promise<T>
  ): Promise<T> {
    if (!this.request.steps.some(step => step.key === key && step.kind === kind))
      throw templateImportStateError(this.locale)
    const id = this.receipt(key)
    if (id) return restore(id)
    const created = await write(this.context(key))
    await this.confirm(key, created.id)
    return created
  }
}

async function executeImport(
  session: ImportSession,
  intent: ProjectTemplateImportIntent,
  partialMessage: string,
  hooks: ConfigurationHooks
) {
  const { api, projectId } = session
  if (!api.projects.createCollaborationGroup || !api.projects.listCollaborationGroups)
    throw templateImportStateError(session.locale)
  if (session.operation.status !== 'completed') {
    const preflightApi = api.automations
      ? {
          ...api,
          automations: {
            ...api.automations,
            list: async (id: string) => {
              const rules = await api.automations!.list(id)
              await session.refresh()
              const ownId = session.receipt(templateImportAutomationStep)
              return rules.filter(rule => rule.id !== ownId)
            },
          },
        }
      : api
    await hooks.prepare(preflightApi, projectId, intent.document, intent.executionLocale)
  }
  const resolved = await materializeTemplateAgents(
    api,
    projectId,
    intent.document,
    intent.drafts,
    partialMessage,
    (agent, routing) =>
      session.resource(
        `agent:${agent.key}`,
        'agent',
        context => api.agents.create(projectId, templateAgentCreateInput(agent, routing), context),
        async id => {
          const agents = await api.agents.list(projectId, { forceRefresh: true })
          const agent = agents.find(candidate => candidate.id === id)
          if (!agent) throw templateImportStateError(session.locale)
          return agent
        }
      ),
    projectTemplateImportRouting(intent)
  )
  let index = 0
  const groups = await applyTemplateGroups(
    resolved.drafts,
    draft => {
      const key = `group:${intent.document.spec.resources.collaboration.groups[index++].key}`
      return session.resource(
        key,
        'group',
        context =>
          api.projects.createCollaborationGroup!(
            projectId,
            {
              ...normalizeCollaborationGroupDraftForPersistence(draft),
              coordinationMode: 'manager',
            },
            context
          ),
        async id => {
          const groups = await api.projects.listCollaborationGroups!(projectId)
          const group = groups.find(candidate => candidate.id === id)
          if (!group) throw templateImportStateError(session.locale)
          return group
        }
      )
    },
    partialMessage
  )
  const key = (kind: 'automation' | 'board') =>
    kind === 'automation' ? templateImportAutomationStep : templateImportBoardStep
  await hooks.configure(api, projectId, intent.document, groups, intent.executionLocale, {
    isCompleted: kind => !!session.receipt(key(kind)),
    context: kind => session.context(key(kind)),
    boardId: part => `template-import-${session.operation.id}-${part}`,
    onStepCompleted: (kind, id) => session.confirm(key(kind), id),
  })
  await session.refresh()
  if (session.operation.status !== 'completed') throw templateImportStateError(session.locale)
  await api.projects.get(projectId)
  return groups
}

async function runImport(
  api: SharedWorkspaceApi,
  projectId: string,
  locale: CollaborationLocale,
  partialMessage: string,
  hooks: ConfigurationHooks,
  load: () => Promise<{ intent: ProjectTemplateImportIntent; operation: TemplateImportOperation }>,
  onGroupsRefreshed?: (groups: CollaborationGroup[]) => void
) {
  let session: ImportSession | undefined
  try {
    const { intent, operation } = await load()
    session = new ImportSession(
      api,
      projectId,
      projectTemplateImportRequest(intent),
      operation,
      locale
    )
    return await executeImport(session, intent, partialMessage, hooks)
  } catch (cause) {
    if (session) {
      try {
        await session.refresh()
      } catch {
        /* Preserve the mutation error if reading progress also fails. */
      }
    }
    try {
      const groups = await api.projects.listCollaborationGroups?.(projectId)
      if (groups) onGroupsRefreshed?.(groups)
    } catch {
      /* Retrying uses the durable operation even when resource reads are unavailable. */
    }
    throw new TemplateImportRetryError(cause, locale, session?.operation)
  }
}

export function applyDurableProjectTemplate(
  api: SharedWorkspaceApi,
  projectId: string,
  document: CollaborationTemplate,
  drafts: ProjectCreateCollaborationGroupDraft[],
  locale: CollaborationLocale,
  partialMessage: string,
  resolveRouting: TemplateRoutingResolver | undefined,
  onGroupsRefreshed: ((groups: CollaborationGroup[]) => void) | undefined,
  hooks: ConfigurationHooks
) {
  return runImport(
    api,
    projectId,
    locale,
    partialMessage,
    hooks,
    async () => {
      const intent = await freezeProjectTemplateImportIntent(
        document,
        drafts,
        locale,
        resolveRouting
      )
      const operation = await api.templateImports!.begin(
        projectId,
        projectTemplateImportRequest(intent)
      )
      return { intent, operation }
    },
    onGroupsRefreshed
  )
}

export function resumeDurableProjectTemplate(
  api: SharedWorkspaceApi,
  projectId: string,
  operationId: string,
  locale: CollaborationLocale,
  onGroupsRefreshed: ((groups: CollaborationGroup[]) => void) | undefined,
  hooks: ConfigurationHooks
) {
  return runImport(
    api,
    projectId,
    locale,
    templateMessages[locale].partial,
    hooks,
    async () => {
      if (!api.templateImports || !((await api.templateImports.supports?.(projectId)) ?? true))
        throw templateImportStateError(locale)
      const operation = await api.templateImports.get(projectId, operationId)
      if (operation.id !== operationId) throw templateImportStateError(locale)
      const intent = readProjectTemplateImportIntent(operation, locale)
      return { intent, operation }
    },
    onGroupsRefreshed
  )
}
