// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { KnowledgeBaseCreate } from '@/types/knowledge'

/**
 * A code wiki is a knowledge base an agent writes from a source repository.
 *
 * It belongs to whoever created it and is governed by the ordinary knowledge-base
 * ACL, so it appears in the general list alongside every other kind. These endpoints
 * exist only because its list items carry repository fields; they grant nothing the
 * general list would not.
 */
export interface CodeWikiSummary {
  id: number
  name: string
  description?: string | null
  /** Repository the wiki documents, e.g. `wecode-ai/Wegent`. */
  project_name: string
  source_url: string
  /** When the live version was published; null when nothing has been. */
  last_published_at?: string | null
  /** Commit the live version documents. */
  last_published_commit: string
  document_count: number
  created_at: string
  updated_at: string
}

export interface CodeWikiListResponse {
  items: CodeWikiSummary[]
  total: number
}

/**
 * Everything a knowledge base is created with, plus the repository.
 *
 * Extends rather than restates: a code wiki is an ordinary knowledge base with a
 * repository attached, so retrieval, summary, guided questions and call limits all
 * apply. A hand-picked subset silently drops whatever the form collected and this
 * type forgot, which is how the summary settings went missing twice.
 */
export interface CodeWikiCreateRequest extends Omit<
  KnowledgeBaseCreate,
  'name' | 'namespace' | 'kb_type'
> {
  /** Optional: left blank, the repository's own name is used. */
  name: string
  /** Where to file it, as for any knowledge base. Defaults to personal. */
  namespace?: string
  source_type: CodeWikiSourceType
  source_url: string
  /** Empty falls back to the deployment default rather than meaning English. */
  language?: string
  /**
   * Whether generation runs appear in the creator's conversation list. Off by
   * default: a wiki regenerates on its own, so its runs are work nobody started a
   * conversation to do. The wiki's own run history shows them either way.
   */
  show_generation_task?: boolean
}

export type CodeWikiSourceType = 'github' | 'gitlab' | 'gitea'

/** A wiki of this repository somebody has already built. */
export interface CodeWikiExisting {
  id: number
  name: string
  /** Who to ask, when it is not accessible. */
  owner_name: string
  /** Whether the caller can already open it. */
  accessible: boolean
}

/**
 * What is known about a repository before a wiki is bound to it.
 *
 * `exists: false` means "not readable with what you have". Private and absent are
 * deliberately indistinguishable — telling them apart would disclose which private
 * repositories exist.
 */
export interface CodeWikiResolution {
  exists: boolean
  /** `public` or `private`, when readable. */
  visibility: string
  /** Saves listing branches, which has no path for a repository read anonymously. */
  default_branch: string
  /** Repository path, offered as the wiki's name when none is given. */
  name: string
  description: string
  /** `public`, `member`, or `none`. */
  access: string
  /** Wikis that already document this repository, whoever owns them. */
  existing_wikis: CodeWikiExisting[]
}

/**
 * What happened when a wiki was asked to regenerate.
 *
 * `started: false` is a success, not a failure: the repository had not changed since
 * the published version, so there was nothing to build.
 */
export interface CodeWikiRunResponse {
  started: boolean
  /** `full`, `incremental` or `skip`. */
  mode: string
  reason: string
  generation_id: number
  task_id: number
}

/**
 * One node of the reader's navigation.
 *
 * Every node is a page. The tree is derived from page paths, and a section that holds
 * pages but has no page of its own renders as a heading that cannot be opened —
 * allowed, and reported by the publish gate as a warning.
 */
export interface CodeWikiPageNode {
  /** Stable path, e.g. `architecture/backend`. Identity, not a display value. */
  path: string
  /** What the page is called; the document's name. */
  title: string
  /** 0 for a section that holds pages but has none of its own. */
  document_id: number
  /** False for such a section: a heading that cannot be opened. */
  has_content: boolean
  children: CodeWikiPageNode[]
}

export interface CodeWikiPageTree {
  pages: CodeWikiPageNode[]
}

/**
 * Whether anything is being done to this wiki, and what came of it last time.
 *
 * Fetched separately from the page tree: while a run is going the client polls this,
 * and the tree is large enough that repeating it every few seconds would be the
 * wrong thing to poll.
 */
export interface CodeWikiRunStatus {
  status: 'running' | 'failed' | 'completed' | 'never'
  generation_id: number
  started_at?: string | null
  /** Why the last run failed, if it did. Verbatim, and possibly not translated. */
  error_message: string
  /**
   * Names a failure the server stated in its own words, for translating here. Empty
   * means the reason came from outside — the agent, git, an exception — and
   * `error_message` is all there is.
   */
  failure_code: string
  /**
   * A run whose worker has gone quiet for longer than the sweep tolerates.
   * Triggering again reclaims it and starts afresh, so this is offered as an action
   * rather than reported as the wiki being busy.
   */
  is_stale: boolean
  last_published_at?: string | null
  last_published_commit: string
}

/**
 * One past attempt at generating this wiki.
 *
 * Fetched on demand rather than polled alongside the status: the question this
 * answers is not "is it busy" but "why does it look like this", and the answer is
 * usually in a run that already ended.
 */
export interface CodeWikiRunRecord {
  generation_id: number
  status: 'running' | 'failed' | 'completed'
  /** `full` or `incremental`. */
  mode: string
  started_at?: string | null
  /** Null while the run has not ended. */
  completed_at?: string | null
  /** Commit the run was documenting. */
  commit: string
  error_message: string
  /** Names a server-stated failure, for translating here. */
  failure_code: string
  /** Whether this is the version readers currently see. */
  published: boolean
  /**
   * Task that ran the agent. Openable by id even when the task is kept out of the
   * conversation list, which is what makes hiding it safe.
   */
  task_id: number
}

export interface CodeWikiRunHistory {
  runs: CodeWikiRunRecord[]
}
