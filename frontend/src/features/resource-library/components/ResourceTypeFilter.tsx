// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { ResourceLibraryTypeFilter } from '@/features/resource-library/types'

interface ResourceTypeFilterProps {
  value: ResourceLibraryTypeFilter
  onValueChange: (value: ResourceLibraryTypeFilter) => void
}

const RESOURCE_TYPE_FILTERS: ResourceLibraryTypeFilter[] = ['all', 'agent', 'skill']

export function ResourceTypeFilter({ value, onValueChange }: ResourceTypeFilterProps) {
  const { t } = useTranslation('resource-library')

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('fields.tags')}>
      {RESOURCE_TYPE_FILTERS.map(filter => {
        const isActive = value === filter

        return (
          <Button
            key={filter}
            type="button"
            variant={isActive ? 'primary' : 'outline'}
            aria-pressed={isActive}
            data-testid={`resource-type-${filter}-filter`}
            className="h-11 min-w-[44px] px-4 lg:h-9"
            onClick={() => onValueChange(filter)}
          >
            {t(`filters.${filter}`)}
          </Button>
        )
      })}
    </div>
  )
}
