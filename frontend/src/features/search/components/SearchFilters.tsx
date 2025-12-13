// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SortType, DateRangeType } from '../types'

interface SearchFiltersProps {
  sort: SortType
  dateRange: DateRangeType
  onSortChange: (sort: SortType) => void
  onDateRangeChange: (range: DateRangeType, from?: string, to?: string) => void
}

const SORT_OPTIONS: { value: SortType; labelKey: string }[] = [
  { value: 'relevance', labelKey: 'search.sort.relevance' },
  { value: 'date', labelKey: 'search.sort.newest' },
  { value: 'date_asc', labelKey: 'search.sort.oldest' },
]

const DATE_OPTIONS: { value: DateRangeType; labelKey: string }[] = [
  { value: 'all', labelKey: 'search.date.all' },
  { value: '1d', labelKey: 'search.date.day' },
  { value: '7d', labelKey: 'search.date.week' },
  { value: '30d', labelKey: 'search.date.month' },
]

export function SearchFilters({
  sort,
  dateRange,
  onSortChange,
  onDateRangeChange,
}: SearchFiltersProps) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-wrap gap-3 items-center">
      <div className="flex items-center gap-2">
        <span className="text-sm text-text-secondary">{t('search.sort_label', 'Sort:')}</span>
        <Select value={sort} onValueChange={(value) => onSortChange(value as SortType)}>
          <SelectTrigger className="w-[140px] h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map(({ value, labelKey }) => (
              <SelectItem key={value} value={value}>
                {t(labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-sm text-text-secondary">{t('search.date_label', 'Time:')}</span>
        <Select
          value={dateRange}
          onValueChange={(value) => onDateRangeChange(value as DateRangeType)}
        >
          <SelectTrigger className="w-[140px] h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DATE_OPTIONS.map(({ value, labelKey }) => (
              <SelectItem key={value} value={value}>
                {t(labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
