// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, FormEvent } from 'react'
import { Search, XCircle, Building2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import { useDepartmentSearch } from '@wecode/hooks/useDepartmentSearch'
import type { Department } from '@wecode/types/department'
import type { MemberRole } from '@/types/knowledge'
import { ASSIGNABLE_ROLES, BASE_ROLES } from '@/types/base-role'

export interface DepartmentBatchInput {
  id: string
  displayName?: string
}

export interface DepartmentBatchFailed {
  entity_id: string
  entity_type: string
  error: string
}

export interface DepartmentBatchSucceeded {
  entity_id: string
  entity_type: string
  role: string
  entity_display_name?: string
}

export interface DepartmentBatchResponse {
  succeeded: DepartmentBatchSucceeded[]
  failed: DepartmentBatchFailed[]
  total?: number
  success_count?: number
  failed_count?: number
}

const MAX_SELECT_DEPARTMENTS = 30

interface AddDepartmentFormProps {
  onSubmit: (departments: DepartmentBatchInput[], role: string) => Promise<DepartmentBatchResponse>
  onSuccess?: () => void
  onCancel?: () => void
  initialRole?: MemberRole
  /** User's role in the group, for determining available role options. */
  userRole?: string
}

export function AddDepartmentForm({
  onSubmit,
  onSuccess,
  onCancel,
  initialRole = 'Reporter',
  userRole,
}: AddDepartmentFormProps) {
  const { t } = useTranslation('knowledge')

  const {
    departments,
    searching,
    errorKind: searchErrorKind,
    searchQuery,
    setSearchQuery,
    showDropdown,
    setShowDropdown,
    inputRef,
    dropdownRef,
  } = useDepartmentSearch()

  const searchError = searchErrorKind ? t('document.permission.searchFailed') : null

  const [selectedDepartments, setSelectedDepartments] = useState<Department[]>([])
  const [role, setRole] = useState<MemberRole>(initialRole)
  const [loading, setLoading] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const editableRoleOptions = userRole === 'Owner' ? BASE_ROLES : ASSIGNABLE_ROLES

  useEffect(() => {
    setSearchQuery('')
    setSelectedDepartments([])
    setSubmitError(null)
    setRole(initialRole)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isDepartmentSelected = (dept: Department) => selectedDepartments.some(d => d.id === dept.id)

  const uniqueDepartments = departments.filter(
    (d, i, arr) => d.id && arr.findIndex(item => item.id === d.id) === i
  )

  const handleToggleDepartment = (dept: Department) => {
    const isSelected = selectedDepartments.some(d => d.id === dept.id)

    if (!isSelected && selectedDepartments.length >= MAX_SELECT_DEPARTMENTS) {
      setSubmitError(
        t('document.permission.departmentLimitReached', { limit: MAX_SELECT_DEPARTMENTS })
      )
      return
    }

    setSelectedDepartments(prev =>
      isSelected ? prev.filter(d => d.id !== dept.id) : [...prev, dept]
    )
    setSearchQuery('')
    setShowDropdown(false)
    setSubmitError(null)
  }

  const handleRemoveDepartment = (deptId: string) => {
    setSelectedDepartments(prev => prev.filter(d => d.id !== deptId))
  }

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault()
    setSubmitError(null)

    if (selectedDepartments.length === 0) {
      setSubmitError(t('document.permission.selectDepartmentRequired'))
      return
    }

    setLoading(true)
    try {
      const result = await onSubmit(
        selectedDepartments.map(d => ({ id: d.id, displayName: d.name || d.label })),
        role
      )

      if (result.failed.length === 0) {
        resetForm()
        onSuccess?.()
        return
      }

      const failedIds = new Set(
        result.failed.map(f => f.entity_id).filter((v): v is string => Boolean(v))
      )
      const remaining =
        failedIds.size > 0
          ? selectedDepartments.filter(d => failedIds.has(d.id))
          : selectedDepartments
      setSelectedDepartments(remaining)

      const failedNames = result.failed
        .map(f => {
          const dept = selectedDepartments.find(d => d.id === f.entity_id)
          const name = dept?.name || dept?.label || f.entity_id || ''
          return name ? `${name}（${f.error}）` : f.error
        })
        .join('；')
      setSubmitError(
        t('document.permission.partialFailure', {
          count: result.failed.length,
          names: failedNames,
        })
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add department permission'
      setSubmitError(message)
    } finally {
      setLoading(false)
    }
  }

  const resetForm = () => {
    setSelectedDepartments([])
    setRole(initialRole)
    setSearchQuery('')
    setShowDropdown(false)
    setSubmitError(null)
  }

  const handleCancel = () => {
    resetForm()
    onCancel?.()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="md:col-span-2 space-y-2 relative">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
            <Input
              ref={inputRef}
              value={searchQuery}
              onChange={e => {
                setSearchQuery(e.target.value)
                setShowDropdown(true)
              }}
              onFocus={() => {
                if (searchQuery.trim() && departments.length > 0) {
                  setShowDropdown(true)
                }
              }}
              placeholder={t('document.permission.searchDepartmentPlaceholder')}
              className="pl-9"
              data-testid="add-department-search-input"
            />
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
              ) : searchError ? (
                <div
                  className="p-3 text-sm text-error text-center break-words"
                  data-testid="add-department-search-error"
                >
                  {searchError}
                </div>
              ) : uniqueDepartments.length === 0 ? (
                <div className="p-3 text-sm text-text-muted text-center">
                  {searchQuery.trim()
                    ? t('document.permission.noDepartmentResults')
                    : t('document.permission.searchDepartmentPlaceholder')}
                </div>
              ) : (
                uniqueDepartments.map(dept => {
                  const selected = isDepartmentSelected(dept)
                  return (
                    <button
                      key={dept.id}
                      type="button"
                      onClick={() => handleToggleDepartment(dept)}
                      className={`w-full flex items-center justify-between gap-3 p-3 hover:bg-surface cursor-pointer text-left ${
                        selected ? 'bg-primary/5' : ''
                      }`}
                    >
                      <span className="font-medium text-sm text-text-primary truncate flex items-center gap-2">
                        {selected && (
                          <svg
                            className="w-3.5 h-3.5 text-primary flex-shrink-0"
                            fill="currentColor"
                            viewBox="0 0 16 16"
                          >
                            <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                          </svg>
                        )}
                        {dept.name || dept.label || dept.id}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          )}
          {selectedDepartments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {selectedDepartments.map(dept => (
                <div
                  key={dept.id}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted/70 border border-border text-sm"
                >
                  <span className="truncate max-w-[120px]">
                    {dept.name || dept.label || dept.id}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-4 w-4 text-text-muted hover:text-error flex-shrink-0 p-0"
                    onClick={() => handleRemoveDepartment(dept.id)}
                  >
                    <XCircle className="w-3 h-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          <Select value={role} onValueChange={v => setRole(v as MemberRole)}>
            <SelectTrigger data-testid="add-department-role-select">
              <SelectValue placeholder={t(`groups:groups.roles.${role}`)}>
                {t(`groups:groups.roles.${role}`)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {editableRoleOptions.map(r => (
                <SelectItem key={r} value={r}>
                  <div className="flex flex-col">
                    <span>{t(`groups:groups.roles.${r}`)}</span>
                    <span className="text-xs text-text-muted">
                      {t(`groups:groupMembers.roleDescriptions.${r}`)}
                    </span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Role Permission Description */}
      <div className="p-3 bg-muted rounded-md text-xs text-text-muted">
        <strong>{t(`groups:groups.roles.${role}`)}：</strong>
        {t(`groups:groupMembers.roleDescriptions.${role}`)}
      </div>

      {submitError && (
        <div className="flex items-center gap-1.5 text-sm text-error bg-error/10 px-3 py-2 rounded-lg">
          <XCircle className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="break-words">{submitError}</span>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={handleCancel}
          disabled={loading}
          data-testid="cancel-button"
        >
          {t('common:actions.cancel')}
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={loading || selectedDepartments.length === 0}
          data-testid="add-department-submit"
        >
          {loading ? (
            <Spinner className="w-4 h-4" />
          ) : (
            <>
              <Building2 className="w-4 h-4 mr-2" />
              {t('document.permission.addDepartmentButton')}
            </>
          )}
        </Button>
      </div>
    </form>
  )
}
