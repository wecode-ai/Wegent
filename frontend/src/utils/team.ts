// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Team } from '@/types/api'

const parseTimestamp = (value?: string) => {
  if (!value) return 0
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

export const sortTeamsByUpdatedAt = (teams: Team[]) => {
  return [...teams].sort((a, b) => parseTimestamp(b.updated_at) - parseTimestamp(a.updated_at))
}
