// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ApiError } from '@/apis/client'

interface ReferencedBot {
  name?: unknown
}

interface CapabilityReferenceErrorDetail {
  referenced_bots?: ReferencedBot[]
  referenced_knowledge_bases?: ReferencedBot[]
}

export function getReferencedBotNames(error: unknown): string[] {
  if (!(error instanceof ApiError) || error.errorCode !== 'CAPABILITY_REFERENCE_IN_USE') {
    return []
  }

  const detail = error.detail as CapabilityReferenceErrorDetail | undefined
  return (detail?.referenced_bots || [])
    .map(bot => bot.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
}

export function getReferencedKnowledgeBaseNames(error: unknown): string[] {
  if (!(error instanceof ApiError) || error.errorCode !== 'CAPABILITY_REFERENCE_IN_USE') {
    return []
  }

  const detail = error.detail as CapabilityReferenceErrorDetail | undefined
  return (detail?.referenced_knowledge_bases || [])
    .map(knowledgeBase => knowledgeBase.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
}
