// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ExternalKnowledgeRef } from '@/types/context'

export function getExternalKnowledgeScopeKey(ref: ExternalKnowledgeRef): string {
  return `${ref.provider}:${ref.mode}:${ref.id}`
}

export function isSameExternalKnowledgeScope(
  left: ExternalKnowledgeRef,
  right: ExternalKnowledgeRef
): boolean {
  return getExternalKnowledgeScopeKey(left) === getExternalKnowledgeScopeKey(right)
}
