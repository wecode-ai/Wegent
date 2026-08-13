// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Team } from '@/types/api'

/**
 * Teams that may answer questions about a knowledge base.
 *
 * Extracted because it was written twice and the two disagreed: the code wiki
 * reader filtered on `chat` rather than `knowledge`, which excluded every team the
 * document panel accepts and left the reader reporting that no agent existed.
 *
 * An absent `bind_mode` means the team predates binding and is allowed everywhere.
 * An empty one is a team explicitly bound to nothing, which is not the same thing.
 */
export function knowledgeCapableTeams(teams: Team[]): Team[] {
  return teams.filter(team => {
    if (Array.isArray(team.bind_mode) && team.bind_mode.length === 0) return false
    if (!team.bind_mode) return true
    return team.bind_mode.includes('knowledge')
  })
}
