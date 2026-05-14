// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { KnowledgeBaseWithGroupInfo } from '@/types/knowledge'

/**
 * Build a list of share-source labels for a knowledge base.
 * Each source is represented as a separate string so callers can
 * decide how to render them (e.g. comma-separated, chips, etc.).
 */
export function getKbShareSourceLabels(kb: KnowledgeBaseWithGroupInfo): string[] {
  const labels: string[] = []

  if (kb.source_group) {
    labels.push(kb.source_group)
  }

  if (kb.shared_from_users && kb.shared_from_users.length > 0) {
    labels.push(...kb.shared_from_users)
  } else if (kb.shared_from) {
    labels.push(kb.shared_from)
  }

  return labels
}

/**
 * Return a single display string for all share sources.
 * Falls back to '--' when there are no sources.
 */
export function getKbShareSourceText(kb: KnowledgeBaseWithGroupInfo): string {
  const labels = getKbShareSourceLabels(kb)
  return labels.join(', ') || '--'
}
