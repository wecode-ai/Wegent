// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Which agents may answer questions about a knowledge base.
 *
 * This was written twice and the two disagreed: the code wiki reader filtered on a
 * `chat` bind mode where the document panel beside it filters on `knowledge`, which
 * is what these teams are actually bound to. Every team was excluded, so the reader
 * reported that no agent existed and its chat could not be used at all.
 */

import { knowledgeCapableTeams } from '@/features/knowledge/document/utils/knowledgeTeams'
import type { Team } from '@/types/api'

const team = (name: string, bind_mode?: string[]) => ({ id: 1, name, bind_mode }) as Team

describe('teams that can answer about a knowledge base', () => {
  it('keeps the ones bound to knowledge', () => {
    const kept = knowledgeCapableTeams([team('wiki', ['knowledge'])])

    expect(kept).toHaveLength(1)
  })

  it('keeps a team that predates binding', () => {
    // No bind_mode at all means the team was made before binding existed. Excluding
    // it would silently retire every team a deployment already had.
    expect(knowledgeCapableTeams([team('legacy')])).toHaveLength(1)
  })

  it('drops a team bound to nothing, which is not the same as unbound', () => {
    expect(knowledgeCapableTeams([team('bound-to-nothing', [])])).toHaveLength(0)
  })

  it('drops a team bound only elsewhere', () => {
    // The filter that broke it looked for `chat`, so this is the case that decides
    // whether the two definitions have been reconciled or merely both kept.
    expect(knowledgeCapableTeams([team('coder', ['code'])])).toHaveLength(0)
    expect(knowledgeCapableTeams([team('chatter', ['chat'])])).toHaveLength(0)
  })
})
