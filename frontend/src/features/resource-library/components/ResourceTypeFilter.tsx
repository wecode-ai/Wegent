// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslation } from '@/hooks/useTranslation'
import type { ResourceNavigationType } from '@/features/resource-library/types'

interface ResourceTypeFilterProps {
  value: ResourceNavigationType
  onValueChange: (value: ResourceNavigationType) => void
  filters?: ResourceNavigationType[]
  marketLabels?: boolean
}

const RESOURCE_TYPE_FILTERS: ResourceNavigationType[] = [
  'all',
  'agent',
  'skill',
  'model',
  'shell',
  'retriever',
  'mcp',
]

export function ResourceTypeFilter({
  value,
  onValueChange,
  filters = RESOURCE_TYPE_FILTERS,
  marketLabels = false,
}: ResourceTypeFilterProps) {
  const { t } = useTranslation('resource-library')

  return (
    <Tabs
      value={value}
      onValueChange={nextValue => onValueChange(nextValue as ResourceNavigationType)}
      className="min-w-0 max-w-full"
    >
      <TabsList
        className="inline-flex h-auto w-fit max-w-full justify-start gap-7 overflow-x-auto rounded-none bg-transparent p-0"
        aria-label={t('fields.type')}
        data-testid="resource-type-navigation"
      >
        {filters.map(filter => {
          const isActive = value === filter
          const labelKey =
            marketLabels && (filter === 'agent' || filter === 'skill' || filter === 'mcp')
              ? `market_filters.${filter}`
              : `filters.${filter}`

          return (
            <TabsTrigger
              key={filter}
              value={filter}
              aria-pressed={isActive}
              data-testid={`resource-type-${filter}-filter`}
              className="relative h-11 min-w-[44px] shrink-0 rounded-none border-0 bg-transparent px-1 font-medium text-text-secondary shadow-none after:absolute after:bottom-1 after:left-1 after:right-1 after:h-0.5 after:bg-transparent hover:text-text-primary data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-text-primary data-[state=active]:shadow-none data-[state=active]:after:bg-primary"
            >
              {t(labelKey)}
            </TabsTrigger>
          )
        })}
      </TabsList>
    </Tabs>
  )
}
