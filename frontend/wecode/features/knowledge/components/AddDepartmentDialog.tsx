// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, FormEvent } from 'react'
import { Search, XCircle, Building2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
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
import { knowledgePermissionExtensionApi } from '@wecode/apis/knowledge-permission-extension'
import { useDepartmentSearch } from '@wecode/hooks/useDepartmentSearch'
import type { Department } from '@wecode/types/department'
import type { MemberRole } from '@/types/knowledge'

interface AddDepartmentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kbId: number
  onSuccess?: () => void
}

export function AddDepartmentDialog({
  open,
  onOpenChange,
  kbId,
  onSuccess,
}: AddDepartmentDialogProps) {
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
  const [role, setRole] = useState<MemberRole>('Reporter')
  const [loading, setLoading] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Clear state when dialog opens
  useEffect(() => {
    if (open) {
      setSearchQuery('')
      setSelectedDepartments([])
      setSubmitError(null)
      setRole('Reporter')
    }
    // setSearchQuery is stable from the hook; intentionally not in deps to
    // avoid re-running on every render of the hook's identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const isDepartmentSelected = (dept: Department) => selectedDepartments.some(d => d.id === dept.id)

  const handleToggleDepartment = (dept: Department) => {
    setSelectedDepartments(prev =>
      prev.some(d => d.id === dept.id) ? prev.filter(d => d.id !== dept.id) : [...prev, dept]
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
      const result = await knowledgePermissionExtensionApi.batchAddDepartmentPermission(
        kbId,
        selectedDepartments.map(d => ({ id: d.id, displayName: d.name || d.label })),
        role
      )

      if (result.failed.length === 0) {
        resetForm()
        onSuccess?.()
        onOpenChange(false)
        return
      }

      onSuccess?.()

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
    setRole('Reporter')
    setSearchQuery('')
    setShowDropdown(false)
    setSubmitError(null)
  }

  const handleClose = () => {
    resetForm()
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        // Block closing while a submit is in flight so the user does not
        // dismiss the dialog before they see the result.
        if (loading && !next) return
        if (!next) {
          handleClose()
        } else {
          onOpenChange(next)
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="w-5 h-5" />
            {t('document.permission.addDepartment')}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">
              {t('document.permission.selectDepartment')}
            </label>
            <div className="relative">
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
                      className="p-3 text-sm text-error text-center"
                      data-testid="add-department-search-error"
                    >
                      {searchError}
                    </div>
                  ) : departments.length === 0 ? (
                    <div className="p-3 text-sm text-text-muted text-center">
                      {searchQuery.trim()
                        ? t('document.permission.noDepartmentResults')
                        : t('document.permission.searchDepartmentPlaceholder')}
                    </div>
                  ) : (
                    departments.map(dept => {
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
                          {typeof dept.employee_count === 'number' && (
                            <span className="flex-shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] leading-tight font-medium bg-muted text-text-muted border border-border">
                              {dept.employee_count}
                              {t('document.permission.members')}
                            </span>
                          )}
                        </button>
                      )
                    })
                  )}
                </div>
              )}
            </div>
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

          <div className="space-y-2">
            <label className="text-sm font-medium">{t('document.permission.role.label')}</label>
            <Select value={role} onValueChange={v => setRole(v as MemberRole)}>
              <SelectTrigger className="w-full h-11 min-w-[44px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Maintainer">
                  <div>
                    <div className="font-medium">{t('document.permission.role.Maintainer')}</div>
                    <div className="text-xs text-text-muted">
                      {t('document.permission.role.MaintainerDescription')}
                    </div>
                  </div>
                </SelectItem>
                <SelectItem value="Developer">
                  <div>
                    <div className="font-medium">{t('document.permission.role.Developer')}</div>
                    <div className="text-xs text-text-muted">
                      {t('document.permission.role.DeveloperDescription')}
                    </div>
                  </div>
                </SelectItem>
                <SelectItem value="Reporter">
                  <div>
                    <div className="font-medium">{t('document.permission.role.Reporter')}</div>
                    <div className="text-xs text-text-muted">
                      {t('document.permission.role.ReporterDescription')}
                    </div>
                  </div>
                </SelectItem>
                <SelectItem value="RestrictedAnalyst">
                  <div>
                    <div className="font-medium">
                      {t('document.permission.role.RestrictedAnalyst')}
                    </div>
                    <div className="text-xs text-text-muted">
                      {t('document.permission.role.RestrictedAnalystDescription')}
                    </div>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {submitError && (
            <div className="flex items-center gap-1.5 text-sm text-error bg-error/10 px-3 py-2 rounded-lg">
              <XCircle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>{submitError}</span>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={loading}
              data-testid="cancel-button"
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={loading || selectedDepartments.length === 0}
              data-testid="add-department-submit"
            >
              {loading ? <Spinner className="w-4 h-4" /> : t('document.permission.add')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
