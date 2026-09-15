// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Search, X, User, Users, Building2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/hooks/useTranslation'
import type { CollaboratorType, SearchResultItem } from '../types'

interface CollaboratorSearchInputProps {
  type: CollaboratorType
  onTypeChange: (type: CollaboratorType) => void
  query: string
  onQueryChange: (query: string) => void
  onSearch: () => void
  results: SearchResultItem[]
  selectedItems: SearchResultItem[]
  onToggleItem: (item: SearchResultItem) => void
  loading: boolean
}

const COLLABORATOR_TYPES: {
  value: CollaboratorType
  labelKey: string
  icon: typeof User
}[] = [
  { value: 'user', labelKey: 'document.permission.collaboratorType.user', icon: User },
  { value: 'group', labelKey: 'document.permission.collaboratorType.group', icon: Users },
  {
    value: 'department',
    labelKey: 'document.permission.collaboratorType.department',
    icon: Building2,
  },
]

export function CollaboratorSearchInput({
  type,
  onTypeChange,
  query,
  onQueryChange,
  onSearch,
  results,
  selectedItems,
  onToggleItem,
  loading,
}: CollaboratorSearchInputProps) {
  const { t } = useTranslation('knowledge')

  const placeholder =
    type === 'user'
      ? t('document.permission.search.users')
      : type === 'group'
        ? t('document.permission.search.groups')
        : t('document.permission.search.departments')

  const isSelected = (item: SearchResultItem) =>
    selectedItems.some(s => s.id === item.id && s.type === item.type)

  return (
    <div className="space-y-3">
      <div
        className="flex h-9 rounded-md bg-surface p-0.5"
        data-testid="collaborator-type-segmented"
      >
        {COLLABORATOR_TYPES.map(item => (
          <button
            key={item.value}
            type="button"
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-all ${
              type === item.value
                ? 'bg-white text-text-primary shadow-sm'
                : 'text-text-muted hover:text-text-secondary'
            }`}
            onClick={() => onTypeChange(item.value)}
          >
            <item.icon className="w-3.5 h-3.5" />
            {t(item.labelKey)}
          </button>
        ))}
      </div>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
        <Input
          className="pl-9 h-9"
          placeholder={placeholder}
          value={query}
          onChange={e => onQueryChange(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onSearch()}
          data-testid="collaborator-search-input"
        />
      </div>

      {loading && (
        <div className="text-xs text-text-secondary text-center py-4">
          {t('document.permission.searching')}
        </div>
      )}

      {!loading && results.length > 0 && (
        <div className="space-y-1 max-h-48 overflow-auto">
          {results.map(item => (
            <div
              key={`${item.type}-${item.id}`}
              className={`flex items-center justify-between py-1.5 px-2 rounded-md cursor-pointer text-sm ${
                isSelected(item)
                  ? 'bg-primary/10 text-primary'
                  : 'hover:bg-surface text-text-primary'
              }`}
              onClick={() => onToggleItem(item)}
              data-testid={`search-result-${item.type}-${item.id}`}
            >
              <div className="flex-1 min-w-0 truncate">
                <span>{item.name}</span>
                {item.type === 'user' &&
                  (item.metadata?.employeeId || item.metadata?.departmentName) && (
                    <span className="ml-2 text-[11px] text-text-muted">
                      {t('document.permission.userMetaInfo', {
                        content: [item.metadata.employeeId, item.metadata.departmentName]
                          .filter(Boolean)
                          .join(' · '),
                      })}
                    </span>
                  )}
              </div>
              {isSelected(item) && <X className="w-3.5 h-3.5 flex-shrink-0 ml-2" />}
            </div>
          ))}
        </div>
      )}

      {!loading && results.length === 0 && query && (
        <div className="text-xs text-text-secondary text-center py-4">
          {t('document.permission.noMatchingResults')}
        </div>
      )}
    </div>
  )
}
