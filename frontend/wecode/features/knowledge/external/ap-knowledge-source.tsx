// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { registerExternalKnowledgeSource } from '@/features/knowledge/externalKnowledgeSourceRegistry'
import type { ExternalKnowledgeRef } from '@/types/context'
import {
  getExternalKnowledgePreview,
  listExternalKnowledgeBases,
  listExternalKnowledgeNodes,
} from '@wecode/api/external-knowledge'
import type { ExternalKnowledgeBase } from '@wecode/types/external-knowledge'
import { getExternalKnowledgeBaseCount } from './utils'

const AP_PROVIDER = 'ap'

function toRef(kb: ExternalKnowledgeBase): ExternalKnowledgeRef {
  return {
    provider: AP_PROVIDER,
    mode: 'explicit',
    id: kb.knowledge_base_id,
    name: kb.knowledge_base_name,
    scope: kb.scope ?? undefined,
  }
}

registerExternalKnowledgeSource(AP_PROVIDER, {
  providerId: AP_PROVIDER,
  label: 'WeiboAP',
  capabilities: {
    supportsKnowledgeBaseSelection: true,
    supportsFolderSelection: false,
    supportsDocumentSelection: true,
    supportsDocumentTree: true,
    supportsScopedRetrieval: false,
    supportsPreview: true,
  },
  selectionLimits: {
    maxKnowledgeBases: 100,
  },
  scopes: [
    {
      key: 'personal',
      labelKey: 'picker.scopes.personal',
      icon: 'personal',
    },
    {
      key: 'organization',
      labelKey: 'picker.scopes.organization',
      icon: 'organization',
    },
  ],
  listKnowledgeBases: params => listExternalKnowledgeBases(AP_PROVIDER, params),
  getKnowledgeBaseCount: () => getExternalKnowledgeBaseCount(AP_PROVIDER),
  listNodes: (knowledgeBaseId, params) =>
    listExternalKnowledgeNodes(AP_PROVIDER, knowledgeBaseId, params),
  getPreview: params => getExternalKnowledgePreview(AP_PROVIDER, params),
  toRef,
})
