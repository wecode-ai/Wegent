// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { KbGroupInfo } from '@/types/knowledge'
import type { KbDataItem } from './KnowledgeGroupListPage'
import { getListedPermission } from '../navigation'
import { KnowledgeBaseIcon } from './KnowledgeBaseIcon'

export function KnowledgeMobileList({
  items,
  onSelect,
  getSpace,
  renderActions,
}: {
  items: KbDataItem[]
  onSelect: (kb: KbDataItem) => void
  getSpace?: (kb: KbDataItem) => KbGroupInfo
  renderActions: (kb: KbDataItem) => ReactNode
}) {
  const { t } = useTranslation('knowledge')
  return (
    <ul className="divide-y divide-border" data-testid="knowledge-mobile-list">
      {items.map(kb => (
        <li
          key={kb.id}
          className="flex items-center gap-2 px-4 py-2"
          data-testid={`kb-row-${kb.id}`}
        >
          <div className="min-w-0 flex-1">
            <button
              type="button"
              className="flex min-h-11 w-full items-center gap-2 break-words text-left text-sm font-medium leading-5 [overflow-wrap:anywhere]"
              data-testid={`open-kb-${kb.id}`}
              onClick={() => onSelect(kb)}
            >
              <KnowledgeBaseIcon kbType={kb.kb_type} className="h-4 w-4 shrink-0" />
              <span className="min-w-0">{kb.name}</span>
            </button>

            <dl className="flex min-w-0 flex-1 flex-wrap gap-x-2 gap-y-1 break-words text-xs leading-4 text-text-secondary [overflow-wrap:anywhere]">
              <div className="min-w-0">
                <dt className="sr-only">{t('document.navigation.space')}</dt>
                <dd>{getSpace?.(kb).groupName ?? t('document.navigation.unknownSpace')}</dd>
              </div>
              {getListedPermission(kb) && (
                <div>
                  <dt className="sr-only">{t('document.navigation.effectivePermission')}</dt>
                  <dd>{t(`document.permission.role.${getListedPermission(kb)}`)}</dd>
                </div>
              )}
            </dl>
          </div>
          <div className="shrink-0">{renderActions(kb)}</div>
        </li>
      ))}
    </ul>
  )
}
