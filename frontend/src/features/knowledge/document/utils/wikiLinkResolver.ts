// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { listKnowledgeBases } from '@/apis/knowledge'
import { buildKbUrl } from '@/utils/knowledgeUrl'

/**
 * Resolve a relative path against a base directory.
 * Returns the normalized path (may start with "../" if it escapes the root).
 */
export function resolveRelativePath(baseDir: string, relativePath: string): string {
  // Split base dir into segments (filter empty strings)
  const baseParts = baseDir ? baseDir.split('/').filter(Boolean) : []
  const relParts = relativePath.split('/')

  const stack = [...baseParts]
  for (const part of relParts) {
    if (part === '..') {
      if (stack.length > 0) {
        stack.pop()
      } else {
        // Escaping root - push sentinel to track depth
        stack.push('..')
      }
    } else if (part !== '.') {
      stack.push(part)
    }
  }

  return stack.join('/')
}

/** Check if a knowledge base exists by name and namespace. Returns true if found. */
export async function checkKnowledgeBaseExists(name: string, namespace: string): Promise<boolean> {
  try {
    const response = await listKnowledgeBases('all')
    return response.items.some(
      item =>
        item.name.toLowerCase() === name.toLowerCase() &&
        item.namespace.toLowerCase() === namespace.toLowerCase()
    )
  } catch {
    return false
  }
}

/**
 * Resolve a relative wiki document link to a knowledge base page URL.
 *
 * The virtual path hierarchy is: namespace/kb-name/doc-path/file.ext
 * Resolution uses standard relative path semantics from the current document's
 * virtual full path.
 *
 * Examples (current doc: "default/my-wiki/src/rag.md"):
 *   - "sibling.md"                    → same KB (stays within "default/my-wiki/src/")
 *   - "../other.md"                   → same KB parent dir ("default/my-wiki/")
 *   - "../../other-kb/path.md"        → cross-KB, same namespace ("default/other-kb/")
 *   - "../../../other-ns/kb/path.md"  → cross-namespace KB
 *
 * Returns null if the href is not a relative wiki link (e.g. absolute HTTP URL).
 */
export async function resolveWikiLink(
  href: string,
  currentKbId: number,
  currentDocName: string,
  currentKbName: string,
  currentNamespace: string,
  currentIsOrganization: boolean
): Promise<string | null> {
  // Skip external URLs and anchor-only links
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) || href.startsWith('#')) {
    return null
  }

  // Handle absolute virtual paths: /namespace/kb-name/optional/path/doc.md
  if (href.startsWith('/')) {
    const parts = href.slice(1).split('/').filter(Boolean)
    if (parts.length < 2) return null
    // Decode URI components to handle non-ASCII characters in namespace/kb-name
    const targetNamespace = decodeURIComponent(parts[0])
    const targetKbName = decodeURIComponent(parts[1])
    // doc path is everything after namespace/kb-name (decode each segment)
    const docPath = parts
      .slice(2)
      .map(p => decodeURIComponent(p))
      .join('/')

    // Same KB - no lookup needed
    if (targetNamespace === currentNamespace && targetKbName === currentKbName) {
      return buildKbUrl(
        currentNamespace,
        currentKbName,
        currentIsOrganization,
        docPath || undefined
      )
    }

    // Different KB - verify it exists then construct virtual URL directly (no kbId lookup needed)
    // For cross-KB links, we don't know isOrganization, so use namespace-based URL
    const exists = await checkKnowledgeBaseExists(targetKbName, targetNamespace)
    if (!exists) return null
    return buildKbUrl(targetNamespace, targetKbName, false, docPath || undefined)
  }

  // Handle relative paths using virtual path hierarchy: namespace/kb-name/doc-path
  // e.g. current doc "default/my-wiki/src/rag.md" → virtualDir = "default/my-wiki/src"
  const virtualDocPath = `${currentNamespace}/${currentKbName}/${currentDocName}`
  const virtualDir = virtualDocPath.slice(0, virtualDocPath.lastIndexOf('/'))

  // Decode href in case the markdown renderer URL-encoded non-ASCII characters
  const decodedHref = decodeURIComponent(href)
  const resolved = resolveRelativePath(virtualDir, decodedHref)

  // resolved is a normalized path like "default/other-kb/path.md" or "../escaped/path.md"
  // Since the virtual base has at least 2 segments (ns/kb), any non-escaped result
  // will have the first segment as namespace and second as kb-name.
  const parts = resolved.split('/')

  if (parts.length >= 2 && !parts[0].startsWith('..')) {
    const targetNamespace = parts[0]
    const targetKbName = parts[1]
    // doc path is everything after namespace/kb-name
    const docPath = parts.slice(2).join('/')

    // Same KB - no lookup needed
    if (targetNamespace === currentNamespace && targetKbName === currentKbName) {
      return buildKbUrl(
        currentNamespace,
        currentKbName,
        currentIsOrganization,
        docPath || undefined
      )
    }

    // Different KB - verify it exists then construct virtual URL directly (no kbId lookup needed)
    // For cross-KB links, we don't know isOrganization, so use namespace-based URL
    const exists = await checkKnowledgeBaseExists(targetKbName, targetNamespace)
    if (!exists) return null
    return buildKbUrl(targetNamespace, targetKbName, false, docPath || undefined)
  }
  // Resolved path escaped the virtual root entirely - treat as same KB fallback
  return buildKbUrl(currentNamespace, currentKbName, currentIsOrganization)
}
