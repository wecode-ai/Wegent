// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type KnowledgeBaseGroup = 'personal' | 'group' | 'organization'

export function getKnowledgeBaseGroup(
  namespace: string | null | undefined,
  organizationNamespace?: string | null
): KnowledgeBaseGroup {
  const resolvedNamespace = namespace || 'default'
  const resolvedOrganizationNamespace = organizationNamespace || 'organization'

  if (resolvedNamespace === 'default') {
    return 'personal'
  }

  if (resolvedNamespace === resolvedOrganizationNamespace) {
    return 'organization'
  }

  return 'group'
}
