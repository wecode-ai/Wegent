// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

export type KnowledgeBaseCategory = 'all' | 'document' | 'code'

export function isInKnowledgeBaseCategory(
  kbType: 'notebook' | 'classic' | 'code_wiki' | null | undefined,
  category: KnowledgeBaseCategory
) {
  if (category === 'all') return true
  return category === 'code' ? kbType === 'code_wiki' : kbType !== 'code_wiki'
}

export function KnowledgeBaseCategoryFilter({
  value,
  onValueChange,
  showCode,
}: {
  value: KnowledgeBaseCategory
  onValueChange: (value: KnowledgeBaseCategory) => void
  showCode: boolean
}) {
  const { t } = useTranslation('knowledge')
  const options: KnowledgeBaseCategory[] = showCode
    ? ['all', 'document', 'code']
    : ['all', 'document']

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="tablist"
      aria-label={t('document.knowledgeBase.categoryFilter.label')}
      data-testid="knowledge-category-filter"
    >
      {options.map(option => {
        const isActive = value === option
        return (
          <Button
            key={option}
            type="button"
            variant={isActive ? 'primary' : 'outline'}
            aria-pressed={isActive}
            data-testid={`knowledge-category-${option}-filter`}
            className="h-11 min-w-[44px] px-4 lg:h-9"
            onClick={() => onValueChange(option)}
          >
            {t(`document.knowledgeBase.categoryFilter.${option}`)}
          </Button>
        )
      })}
    </div>
  )
}
