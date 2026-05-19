// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { AdminPublicTeam, AdminPublicTeamUpdate } from '@/apis/admin'

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
