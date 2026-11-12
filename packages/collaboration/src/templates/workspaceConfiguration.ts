// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { ProjectAgentConfigurationHost } from '../project-agent-config/types'
import type { ProjectCreateCollaborationGroupDraft } from '../project-create/types'
import type { CollaborationGroup, CollaborationWorkspace } from '../types'
import type { CollaborationTemplate } from './types'
import {
  materializeTemplateAgents,
  templateAgentReferences,
  templateAgentId,
  templateRoutingResolver,
} from './agents'
import { applyTemplateGroups, PartialTemplateApplyError, TemplateConfigurationError } from './apply'

export async function applyWorkspaceTemplate(
  api: SharedWorkspaceApi,
  workspace: Pick<CollaborationWorkspace, 'id' | 'namespace' | 'location'>,
  document: CollaborationTemplate,
  drafts: ProjectCreateCollaborationGroupDraft[],
  host: ProjectAgentConfigurationHost | undefined,
  partialMessage: string,
  onGroupCreated: (group: CollaborationGroup) => void,
  unsupportedPolicyMessage = 'Cloud workspaces cannot preserve the template execution settings. Apply it directly to a project instead.',
  locale: 'zh-CN' | 'en' = 'en',
  resolveRouting?: import('./types').TemplateRoutingResolver
): Promise<CollaborationGroup[]> {
  const owner = api.workspaces!
  const referenced = templateAgentReferences(drafts)
  if (
    workspace.location === 'cloud' &&
    document.spec.resources.collaboration.agents?.some(
      agent =>
        referenced.has(templateAgentId(agent.key)) &&
        (agent.executionMode === 'manual_approval' ||
          agent.workspacePolicy !== undefined ||
          agent.maxConcurrentExecutions !== undefined)
    )
  )
    throw new TemplateConfigurationError(unsupportedPolicyMessage)
  const resolved = await materializeTemplateAgents(
    api,
    workspace.id,
    document,
    drafts,
    partialMessage,
    async (agent, routing) => {
      if (workspace.location === 'local' && owner.createTemplateAgent)
        return owner.createTemplateAgent(workspace.id, agent, routing)
      if (!host?.createTemplateAgent) throw new Error('template_agent_creation_unavailable')
      const resource = await host.createTemplateAgent(agent, workspace.namespace, routing)
      try {
        await owner.addAgent(workspace.id, { teamId: Number(resource.id) })
      } catch (cause) {
        throw new PartialTemplateApplyError(partialMessage, { cause })
      }
      return resource
    },
    resolveRouting ?? templateRoutingResolver(host, workspace.location, undefined, locale)
  )
  try {
    return await applyTemplateGroups(
      resolved.drafts,
      async draft => {
        const group = await owner.createCollaborationGroup(workspace.id, {
          ...draft,
          coordinationMode: 'manager',
        })
        onGroupCreated(group)
        return group
      },
      partialMessage
    )
  } catch (cause) {
    if (resolved.agentIds.size) throw new PartialTemplateApplyError(partialMessage, { cause })
    throw cause
  }
}
