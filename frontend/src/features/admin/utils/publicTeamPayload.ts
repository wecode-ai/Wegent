// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { AdminPublicTeam, AdminPublicTeamUpdate } from '@/apis/admin'
import type { PipelineContextPassing, TaskType } from '@/types/api'
import type { TeamMode } from '@/features/settings/components/team-modes'

export const buildPublicTeamJson = (data: {
  baseJson?: Record<string, unknown>
  name: string
  displayName: string
  description: string
  bindMode: TaskType[]
  icon: string | null
  requiresWorkspace: boolean | null
  mode: TeamMode
  members: {
    botName: string
    botPrompt: string
    role?: string
    requireConfirmation?: boolean
    contextPassing?: PipelineContextPassing
  }[]
}): Record<string, unknown> => {
  const baseJson = data.baseJson || {}
  const baseMetadata =
    baseJson.metadata && typeof baseJson.metadata === 'object'
      ? (baseJson.metadata as Record<string, unknown>)
      : {}
  const baseSpec =
    baseJson.spec && typeof baseJson.spec === 'object'
      ? (baseJson.spec as Record<string, unknown>)
      : {}
  const baseCapability =
    baseSpec.capability && typeof baseSpec.capability === 'object'
      ? (baseSpec.capability as Record<string, unknown>)
      : null

  return {
    ...baseJson,
    apiVersion: 'agent.wecode.io/v1',
    kind: 'Team',
    metadata: {
      ...baseMetadata,
      name: data.name,
      namespace: 'default',
      displayName: data.displayName.trim() || undefined,
    },
    spec: {
      ...baseSpec,
      collaborationModel: data.mode,
      bind_mode: data.bindMode,
      description: data.description || undefined,
      icon: data.icon || undefined,
      requiresWorkspace: data.requiresWorkspace ?? true,
      ...(baseCapability && {
        capability: {
          ...baseCapability,
          icon: undefined,
        },
      }),
      members: data.members.map(member => ({
        botRef: {
          name: member.botName,
          namespace: 'default',
        },
        botPrompt: member.botPrompt || undefined,
        role: member.role || undefined,
        requireConfirmation: member.requireConfirmation || undefined,
        contextPassing:
          member.contextPassing && member.contextPassing !== 'none'
            ? member.contextPassing
            : undefined,
      })),
    },
  }
}

const getMetadataName = (teamJson: Record<string, unknown>): string | undefined => {
  const metadata = teamJson.metadata
  if (!metadata || typeof metadata !== 'object') return undefined

  const name = (metadata as Record<string, unknown>).name
  return typeof name === 'string' && name.trim() ? name.trim() : undefined
}

export const resolvePublicTeamName = (
  name: string,
  teamJson: Record<string, unknown>,
  fallback: string
): string => {
  return name.trim() || getMetadataName(teamJson) || fallback
}

export const buildPublicTeamUpdateData = ({
  editingTeam,
  name,
  namespace,
  teamJson,
  isActive,
}: {
  editingTeam: AdminPublicTeam
  name: string
  namespace: string
  teamJson: Record<string, unknown>
  isActive: boolean
}): AdminPublicTeamUpdate => {
  const updateData: AdminPublicTeamUpdate = {
    name: resolvePublicTeamName(name, teamJson, editingTeam.name),
    json: teamJson,
    is_active: isActive,
  }

  if (namespace !== editingTeam.namespace) {
    updateData.namespace = namespace
  }

  return updateData
}
