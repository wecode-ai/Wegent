// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { codeWikiApi } from '@/apis/code-wiki'
import type { CodeWikiSummary } from '@/types/code-wiki'
import type { KnowledgeBaseCreate } from '@/types/knowledge'

type CodeWikiFormData = Omit<KnowledgeBaseCreate, 'namespace'> & {
  selectedGroupId?: string
}

interface CreateCodeWikiParams {
  namespace: string
  data: CodeWikiFormData
}

export type CreateCodeWikiResult = CodeWikiSummary & {
  scheduledUpdateError?: string
}

/**
 * Send the shared knowledge-base form through Code Wiki's creation boundary.
 *
 * Desktop and Mobile collect the same form fields, but a code wiki has a
 * repository-access gate and starts its first generation as part of creation. Keeping
 * that decision here prevents one layout from silently falling back to the ordinary
 * knowledge-base endpoint and losing the repository or execution-model contract.
 */
export async function createCodeWiki({
  namespace,
  data,
}: CreateCodeWikiParams): Promise<CreateCodeWikiResult> {
  const {
    name,
    description,
    kb_type: _kbType,
    selectedGroupId: _selectedGroupId,
    source_type,
    source_url,
    execution_model_ref,
    resolved_name,
    resolved_description,
    scheduled_update,
    ...knowledgeBaseData
  } = data

  if (!source_type || !source_url || !execution_model_ref) {
    throw new Error('Code Wiki creation requires a repository and execution model')
  }

  const created = await codeWikiApi.create({
    ...knowledgeBaseData,
    name: name || resolved_name || '',
    description: description || resolved_description,
    namespace,
    source_type,
    source_url,
    execution_model_ref,
  })
  if (scheduled_update) {
    try {
      await codeWikiApi.configureAutomaticUpdate(created.id, scheduled_update)
    } catch (error) {
      return {
        ...created,
        scheduledUpdateError: error instanceof Error ? error.message : String(error),
      }
    }
  }
  return created
}
