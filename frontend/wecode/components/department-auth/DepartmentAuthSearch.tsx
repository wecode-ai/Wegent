// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useTranslation } from '@/hooks/useTranslation'
import type { AuthEntry } from '@/features/knowledge/document/auth-section-registry'
import type { MemberRole } from '@/types/knowledge'
import { useDepartmentSearch } from '@wecode/hooks/useDepartmentSearch'
import type { Department } from '@wecode/types/department'

interface DepartmentAuthSearchProps {
  role: MemberRole
  onSelect: (entry: AuthEntry) => void
}

export function DepartmentAuthSearch({ role, onSelect }: DepartmentAuthSearchProps) {
  const { t } = useTranslation('knowledge')
  const {
    departments,
    searching,
    errorKind,
    searchQuery,
    setSearchQuery,
    showDropdown,
    setShowDropdown,
    inputRef,
    dropdownRef,
  } = useDepartmentSearch()

  const handleSelect = (dept: Department) => {
    onSelect({
      id: `org_department-${dept.id}`,
      label: dept.name || dept.label || dept.id,
      entityType: 'org_department',
      entityId: dept.id,
      role,
    })
    setSearchQuery('')
    setShowDropdown(false)
  }

  return (
    <div className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
        <Input
          ref={inputRef}
          value={searchQuery}
          onChange={e => {
            setSearchQuery(e.target.value)
            if (e.target.value.trim()) {
              setShowDropdown(true)
            }
          }}
          onFocus={() => {
            if (searchQuery.trim() && departments.length > 0) {
              setShowDropdown(true)
            }
          }}
          placeholder={t('document.permission.searchDepartmentPlaceholder')}
          className="pl-9"
          data-testid="department-search-input"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => {
              setSearchQuery('')
              setShowDropdown(false)
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
            data-testid="department-search-clear"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      {showDropdown && (
        <div
          ref={dropdownRef}
          className="absolute z-50 w-full mt-1 bg-base border border-border rounded-md shadow-lg max-h-48 overflow-y-auto"
        >
          {searching ? (
            <div className="flex items-center justify-center p-3">
              <Spinner className="w-4 h-4" />
            </div>
          ) : errorKind ? (
            <div
              className="p-3 text-sm text-error text-center"
              data-testid="department-search-error"
            >
              {t('document.permission.searchFailed')}
            </div>
          ) : departments.length === 0 ? (
            <div className="p-3 text-sm text-text-muted text-center">
              {searchQuery.trim()
                ? t('document.permission.noDepartmentResults')
                : t('document.permission.searchDepartmentPlaceholder')}
            </div>
          ) : (
            departments.map(dept => (
              <button
                key={dept.id}
                type="button"
                onClick={() => handleSelect(dept)}
                className="w-full flex items-center justify-between gap-3 p-3 hover:bg-surface cursor-pointer text-left"
                data-testid={`department-option-${dept.id}`}
              >
                <div className="flex flex-col min-w-0">
                  <span className="font-medium text-sm text-text-primary truncate">
                    {dept.name || dept.label || dept.id}
                  </span>
                  {dept.supervisor_name && (
                    <span className="text-xs text-text-muted truncate">
                      {t('document.permission.supervisor')}: {dept.supervisor_name}
                    </span>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
