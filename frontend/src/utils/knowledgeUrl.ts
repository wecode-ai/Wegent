// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Knowledge Base URL utilities.
 *
 * URL format:
 *   /knowledge/default/{kbName}              → Personal KB (namespace="default", current user)
 *   /knowledge/public/{kbName}               → Organization KB (company scope, no namespace in URL)
 *   /knowledge/{namespace}/{kbName}          → Team KB (namespace=team name)
 *
 * With document path:
 *   /knowledge/default/{kbName}/path/to/doc.md
 *   /knowledge/public/{kbName}/path/to/doc.md
 *   /knowledge/{namespace}/{kbName}/path/to/doc.md
 *
 * Reserved prefixes that cannot be used as team namespace names in URLs:
 *   "default", "public", "document", "project", "share"
 */

/** Reserved path prefixes that cannot be used as team namespace names */
export const KB_URL_RESERVED_PREFIXES = [
  'default',
  'public',
  'document',
  'project',
  'share',
] as const

/**
 * Build the virtual URL for a knowledge base.
 *
 * @param namespace The KB namespace from the backend ("default" for personal, org name for org, team name for team)
 * @param kbName The display name from spec
 * @param isOrganization Whether this KB belongs to an organization-level namespace
 * @param docPath Optional document path to append
 */
export function buildKbUrl(
  namespace: string,
  kbName: string,
  isOrganization: boolean,
  docPath?: string,
  query?: { knowledgeBaseId: number; searchParams?: string }
): string {
  let base: string

  if (namespace === 'default') {
    // Personal KB: /knowledge/default/{kbName}
    base = `/knowledge/default/${encodeURIComponent(kbName)}`
  } else if (isOrganization) {
    // Organization KB: /knowledge/public/{kbName} (namespace omitted, resolved within company KBs)
    base = `/knowledge/public/${encodeURIComponent(kbName)}`
  } else {
    // Team KB: /knowledge/{namespace}/{kbName}
    base = `/knowledge/${encodeURIComponent(namespace)}/${encodeURIComponent(kbName)}`
  }

  if (docPath) {
    const encodedDocPath = docPath.split('/').map(encodeURIComponent).join('/')
    base = `${base}/${encodedDocPath}`
  }

  if (!query) return base
  const searchParams = new URLSearchParams(query.searchParams)
  searchParams.set('kb', String(query.knowledgeBaseId))
  return `${base}?${searchParams.toString()}`
}

/**
 * Parsed components of a KB virtual URL.
 */
export interface ParsedKbUrl {
  /** URL type based on the first path segment */
  type: 'personal' | 'organization' | 'team'
  /** The actual namespace to use for backend queries:
   *  - personal: "default"
   *  - organization: null (must be resolved from backend)
   *  - team: the namespace string
   */
  namespace: string | null
  /** The KB display name */
  kbName: string
  /** Optional document path within the KB */
  docPath?: string
}

/**
 * Parse a KB virtual URL path into its components.
 *
 * Handles three formats:
 *   /knowledge/default/{kbName}/...docPath    → personal KB
 *   /knowledge/public/{kbName}/...docPath     → organization KB
 *   /knowledge/{namespace}/{kbName}/...docPath → team KB
 *
 * @param pathname The URL pathname (e.g. "/knowledge/default/my-kb/src/doc.md")
 * @returns Parsed components or null if not a valid KB URL
 */
export function parseKbUrl(pathname: string): ParsedKbUrl | null {
  // Match: /knowledge/{seg1}/{seg2}[/{rest}]
  const match = pathname.match(/^\/knowledge\/([^/]+)\/([^/]+)(?:\/(.+))?$/)
  if (!match) return null

  const [, seg1, seg2, rest] = match
  const decoded1 = decodeURIComponent(seg1)
  const decoded2 = decodeURIComponent(seg2)
  const docPath = rest
    ? rest
        .split('/')
        .map(s => decodeURIComponent(s))
        .join('/')
    : undefined

  if (decoded1 === 'default') {
    return {
      type: 'personal',
      namespace: 'default',
      kbName: decoded2,
      docPath,
    }
  }

  if (decoded1 === 'public') {
    return {
      type: 'organization',
      namespace: null, // Organization namespace must be resolved from backend
      kbName: decoded2,
      docPath,
    }
  }

  // Team KB: seg1 is namespace, seg2 is kbName
  return {
    type: 'team',
    namespace: decoded1,
    kbName: decoded2,
    docPath,
  }
}

/** Accept only positive, safely representable integer IDs. */
export function parseKnowledgeBaseId(value: string | null | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : null
}

export type KbUrlResolution<T> =
  | { status: 'loading' | 'not-found' | 'ambiguous' | 'error' }
  | { status: 'resolved'; knowledgeBase: T }

/** Resolve within the URL's scope; ordering never determines identity. */
export function resolveKbByVirtualPath<T extends { id: number; name: string; namespace: string }>({
  allKnowledgeBases,
  organizationKnowledgeBases,
  namespace,
  name,
  knowledgeBaseId,
  isLoading,
  hasError = false,
}: {
  allKnowledgeBases: T[]
  organizationKnowledgeBases: T[]
  namespace: string | null | undefined
  name: string
  knowledgeBaseId?: string | null
  isLoading: boolean
  hasError?: boolean
}): KbUrlResolution<T> {
  const requestedId = parseKnowledgeBaseId(knowledgeBaseId)
  if (knowledgeBaseId != null && requestedId === null) return { status: 'not-found' }
  if (isLoading) return { status: 'loading' }
  if (hasError) return { status: 'error' }
  const candidates = namespace ? allKnowledgeBases : organizationKnowledgeBases
  const matches = new Map(
    candidates
      .filter(
        kb =>
          (requestedId !== null
            ? kb.id === requestedId
            : kb.name.toLowerCase() === name.toLowerCase()) &&
          (!namespace || kb.namespace.toLowerCase() === namespace.toLowerCase())
      )
      .map(kb => [kb.id, kb])
  )
  if (matches.size === 0) return { status: 'not-found' }
  if (matches.size > 1) return { status: 'ambiguous' }
  return { status: 'resolved', knowledgeBase: matches.values().next().value! }
}

/** Preserve identity and page context when a display name changes. */
export function getCanonicalKbUrl(
  kb: { id: number; name: string; namespace: string },
  route: Pick<ParsedKbUrl, 'namespace' | 'kbName' | 'docPath'>,
  query: string
): string | null {
  const searchParams = new URLSearchParams(query)
  if (route.kbName === kb.name && searchParams.get('kb') === String(kb.id)) return null
  return buildKbUrl(kb.namespace, kb.name, !route.namespace, route.docPath, {
    knowledgeBaseId: kb.id,
    searchParams: query,
  })
}
