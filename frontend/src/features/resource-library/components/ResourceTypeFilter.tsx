// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import {
  Bot,
  BrainCircuit,
  Database,
  Layers3,
  Sparkles,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react'

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslation } from '@/hooks/useTranslation'
import type { ResourceLibraryTypeFilter } from '@/features/resource-library/types'

interface ResourceTypeFilterProps {
  value: ResourceLibraryTypeFilter
  onValueChange: (value: ResourceLibraryTypeFilter) => void
  filters?: ResourceLibraryTypeFilter[]
}

const RESOURCE_TYPE_FILTERS: ResourceLibraryTypeFilter[] = [
  'all',
  'agent',
  'skill',
  'model',
  'shell',
  'retriever',
]

const RESOURCE_TYPE_ICONS: Record<ResourceLibraryTypeFilter, LucideIcon> = {
  all: Layers3,
  agent: Bot,
  skill: Sparkles,
  model: BrainCircuit,
  shell: SquareTerminal,
  retriever: Database,
}

export function ResourceTypeFilter({
  value,
  onValueChange,
  filters = RESOURCE_TYPE_FILTERS,
}: ResourceTypeFilterProps) {
  const { t } = useTranslation('resource-library')

  return (
    <Tabs
      value={value}
      onValueChange={nextValue => onValueChange(nextValue as ResourceLibraryTypeFilter)}
      className="w-fit max-w-full"
    >
      <TabsList
        className="inline-flex h-auto w-fit max-w-full justify-start gap-1 overflow-x-auto rounded-xl bg-muted/60 p-1"
        aria-label={t('fields.type')}
        data-testid="resource-type-navigation"
      >
        {filters.map(filter => {
          const isActive = value === filter
          const Icon = RESOURCE_TYPE_ICONS[filter]

          return (
            <TabsTrigger
              key={filter}
              value={filter}
              aria-pressed={isActive}
              data-testid={`resource-type-${filter}-filter`}
              className="h-11 min-w-[44px] shrink-0 gap-2 rounded-lg border border-transparent px-4 font-medium text-text-secondary shadow-none hover:bg-base/70 hover:text-text-primary data-[state=active]:border-border data-[state=active]:bg-surface data-[state=active]:font-semibold data-[state=active]:text-text-primary data-[state=active]:shadow-sm lg:h-9"
            >
              <Icon className="h-4 w-4" aria-hidden />
              {t(`filters.${filter}`)}
            </TabsTrigger>
          )
        })}
      </TabsList>
    </Tabs>
  )
}
