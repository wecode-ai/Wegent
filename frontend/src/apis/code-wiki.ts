// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  CodeWikiCreateRequest,
  CodeWikiListResponse,
  CodeWikiPageTree,
  CodeWikiResolution,
  CodeWikiRunHistory,
  CodeWikiRunStatus,
  CodeWikiRunResponse,
  CodeWikiSourceType,
  CodeWikiSummary,
} from '@/types/code-wiki'
import client from './client'

export const codeWikiApi = {
  /**
   * Code wikis whose repositories the caller can read.
   *
   * Separate from the knowledge base list on purpose: a code wiki belongs to the wiki
   * account, so it appears in none of that list's scopes.
   */
  list: async (params?: { page?: number; limit?: number }): Promise<CodeWikiListResponse> => {
    const query = new URLSearchParams()
    if (params?.page) query.append('page', String(params.page))
    if (params?.limit) query.append('limit', String(params.limit))
    const suffix = query.toString()
    return client.get<CodeWikiListResponse>(
      `/knowledge-bases/code-wikis${suffix ? `?${suffix}` : ''}`
    )
  },

  /**
   * What is known about a repository, before deciding to bind a wiki to it.
   *
   * Answers 200 with `exists: false` for one the caller cannot read: this assists
   * the form rather than asserting something is missing, and a 404 would also make
   * private and absent distinguishable, which they must not be.
   */
  resolve: async (
    source_type: CodeWikiSourceType,
    source_url: string
  ): Promise<CodeWikiResolution> =>
    client.post<CodeWikiResolution>('/knowledge-bases/code-wikis/resolve', {
      source_type,
      source_url,
    }),

  /**
   * Bind a repository and create its wiki, or return the one it already has.
   *
   * One repository has one wiki, so this answers 200 with the existing one rather
   * than refusing — the caller wanted that repository's wiki, not the act of
   * creating it.
   */
  create: async (data: CodeWikiCreateRequest): Promise<CodeWikiSummary> =>
    client.post<CodeWikiSummary>('/knowledge-bases/code-wikis', data),

  /**
   * The navigation: every published page, already nested and ordered.
   *
   * Assembled server-side because the hierarchy is in the page paths and the order
   * is on the knowledge base — merging them here would be a second place for the
   * tree to be wrong.
   */
  pages: async (knowledgeBaseId: number): Promise<CodeWikiPageTree> =>
    client.get<CodeWikiPageTree>(`/knowledge-bases/${knowledgeBaseId}/code-wiki/pages`),

  /**
   * Whether anything is being done to this wiki, and what came of it last time.
   *
   * Needs only read access: it is what explains why regenerating is unavailable,
   * and requiring write access to learn that would leave a reader with an opaque
   * button.
   */
  status: async (knowledgeBaseId: number): Promise<CodeWikiRunStatus> =>
    client.get<CodeWikiRunStatus>(`/knowledge-bases/${knowledgeBaseId}/code-wiki/status`),

  /**
   * What has been attempted on this wiki, newest first.
   *
   * Not polled. It is opened when a reader asks why the wiki looks the way it does,
   * which is a deliberate act, and the answer does not change while they read it.
   */
  history: async (knowledgeBaseId: number): Promise<CodeWikiRunHistory> =>
    client.get<CodeWikiRunHistory>(`/knowledge-bases/${knowledgeBaseId}/code-wiki/generations`),

  /**
   * Make an earlier version the one readers see again.
   *
   * Restores content and structure, not identity: the pages deleted on the way here
   * took their document ids with them, so a citation pointing at one is not repaired
   * by its content coming back.
   */
  republish: async (knowledgeBaseId: number, generationId: number): Promise<CodeWikiRunResponse> =>
    client.post<CodeWikiRunResponse>(
      `/knowledge-bases/${knowledgeBaseId}/code-wiki/generations/${generationId}/publish`,
      {}
    ),

  /**
   * Regenerate the complete wiki now, without waiting for a schedule or a new commit.
   */
  regenerate: async (knowledgeBaseId: number): Promise<CodeWikiRunResponse> =>
    client.post<CodeWikiRunResponse>(`/knowledge-bases/${knowledgeBaseId}/code-wiki/generations`, {
      force_full: true,
    }),
}
