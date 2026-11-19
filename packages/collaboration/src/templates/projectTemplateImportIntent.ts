// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationLocale } from '../i18n'
import type { ProjectCreateCollaborationGroupDraft } from '../project-create/types'
import type { CollaborationTemplate, TemplateAgentRouting, TemplateRoutingResolver } from './types'
import type { TemplateImportBegin, TemplateImportOperation } from './projectTemplateImportTypes'
import {
  templateAgentId,
  templateAgentReferences,
  templateRoutingResolver,
  validateTemplateAgentRouting,
} from './agents'
import { TemplateConfigurationError } from './apply'
import { validateTemplate } from './document'

export interface ProjectTemplateImportIntent {
  document: CollaborationTemplate
  drafts: ProjectCreateCollaborationGroupDraft[]
  routings: Partial<Record<'codex' | 'claude_code', TemplateAgentRouting>>
  executionLocale: CollaborationLocale
  previousImportId?: string
}

export const templateImportAutomationStep = 'automation:task-assignment'
export const templateImportBoardStep = 'board:project-board'

/** Normalize object ordering without changing array ordering or adding transient state. */
export function canonicalTemplateImportJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        )
      : item
  )
}

export function templateImportStateError(locale: CollaborationLocale): TemplateConfigurationError {
  return new TemplateConfigurationError(
    locale === 'zh-CN'
      ? '保存的模板导入状态与当前配置不一致，请刷新后重新选择导入记录。'
      : 'The saved import does not match this configuration. Refresh and select the import again.'
  )
}

export function projectTemplateImportRequest(
  intent: ProjectTemplateImportIntent
): TemplateImportBegin {
  const { document, drafts } = intent
  const collaboration = document.spec.resources.collaboration
  if (drafts.length !== collaboration.groups.length)
    throw templateImportStateError(intent.executionLocale)
  const references = templateAgentReferences(drafts)
  const steps: TemplateImportBegin['steps'] = [
    ...(collaboration.agents ?? [])
      .filter(agent => references.has(templateAgentId(agent.key)))
      .map(agent => ({ key: `agent:${agent.key}`, kind: 'agent' as const })),
    ...collaboration.groups.map(group => ({ key: `group:${group.key}`, kind: 'group' as const })),
    ...(collaboration.project.taskAssignment
      ? [{ key: templateImportAutomationStep, kind: 'automation' as const }]
      : []),
    ...(collaboration.project.board
      ? [{ key: templateImportBoardStep, kind: 'board' as const }]
      : []),
  ]
  return {
    protocolVersion: 1,
    intent: JSON.parse(canonicalTemplateImportJson(intent)) as Record<string, unknown>,
    steps,
  }
}

export async function freezeProjectTemplateImportIntent(
  document: CollaborationTemplate,
  drafts: ProjectCreateCollaborationGroupDraft[],
  executionLocale: CollaborationLocale,
  resolveRouting: TemplateRoutingResolver = templateRoutingResolver()
): Promise<ProjectTemplateImportIntent> {
  const routings = Object.fromEntries(
    await validateTemplateAgentRouting(document, drafts, resolveRouting)
  )
  const intent = { document: validateTemplate(document), drafts, routings, executionLocale }
  return JSON.parse(canonicalTemplateImportJson(intent)) as ProjectTemplateImportIntent
}

/** Saved intent is the source of configuration during explicit cross-client recovery. */
export function readProjectTemplateImportIntent(
  operation: TemplateImportOperation,
  locale: CollaborationLocale = 'en'
): ProjectTemplateImportIntent {
  const value = operation.intent
  if (
    !value ||
    !Array.isArray(value.drafts) ||
    !value.routings ||
    typeof value.routings !== 'object' ||
    Array.isArray(value.routings) ||
    (value.previousImportId !== undefined &&
      (typeof value.previousImportId !== 'string' || !value.previousImportId.trim())) ||
    (value.executionLocale !== 'zh-CN' && value.executionLocale !== 'en')
  )
    throw templateImportStateError(locale)
  try {
    const intent = JSON.parse(canonicalTemplateImportJson(value)) as ProjectTemplateImportIntent
    intent.document = validateTemplate(intent.document)
    projectTemplateImportRequest(intent)
    return intent
  } catch {
    throw templateImportStateError(locale)
  }
}

export function projectTemplateImportRouting(
  intent: ProjectTemplateImportIntent
): TemplateRoutingResolver {
  return async runtime => {
    const routing = intent.routings[runtime]
    if (!routing) throw templateImportStateError(intent.executionLocale)
    return routing
  }
}
