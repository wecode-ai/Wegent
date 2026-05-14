// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useRef } from 'react'
import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useTranslation } from '@/hooks/useTranslation'
import client from '@/apis/client'
import type { AuthEntry } from '@/features/knowledge/document/auth-section-registry'
import type { MemberRole } from '@/types/knowledge'

interface Department {
  id: string
  name: string
  label?: string
  oid?: string
  parent_oid?: string
  supervisor?: string
  supervisor_name?: string
  employee_count?: number
}

interface DepartmentAuthSearchProps {
  role: MemberRole
  onSelect: (entry: AuthEntry) => void
}

export function DepartmentAuthSearch({ role, onSelect }: DepartmentAuthSearchProps) {
  const { t } = useTranslation('knowledge')
  const [departments, setDepartments] = useState<Department[]>([])
  const [searching, setSearching] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const loc = (key: string, fallback: string) => {
    const v = t(key)
    return v && v !== key ? v : fallback
  }

  // Debounced search when query changes
  useEffect(() => {
    if (!searchQuery.trim()) {
      setDepartments([])
      return
    }
    const timer = setTimeout(() => {
      performSearch(searchQuery)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const performSearch = async (query: string) => {
    setSearching(true)
    try {
      const result = await client.get<{ departments: Department[] }>(
        `/internal/departments/search?q=${encodeURIComponent(query)}`
      )
      setDepartments(result.departments || [])
      setShowDropdown(true)
    } catch (_err) {
      setDepartments([])
    } finally {
      setSearching(false)
    }
  }

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
    setDepartments([])
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
          placeholder={loc('document.permission.searchDepartmentPlaceholder', '搜索部门...')}
          className="pl-9"
          data-testid="department-search-input"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => {
              setSearchQuery('')
              setDepartments([])
              setShowDropdown(false)
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
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
          ) : departments.length === 0 ? (
            <div className="p-3 text-sm text-text-muted text-center">
              {searchQuery.trim()
                ? t('common:userSearch.noResults') || '未找到结果'
                : loc('document.permission.searchDepartmentPlaceholder', '搜索部门...')}
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
                      {loc('document.permission.supervisor', '负责人')}: {dept.supervisor_name}
                    </span>
                  )}
                </div>
                {typeof dept.employee_count === 'number' && (
                  <span className="flex-shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] leading-tight font-medium bg-muted text-text-muted border border-border">
                    {dept.employee_count}
                    {loc('document.permission.members', '人')}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
