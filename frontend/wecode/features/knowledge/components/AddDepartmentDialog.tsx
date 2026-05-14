// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useRef, useEffect, FormEvent } from 'react'
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
import client from '@/apis/client'
import type { MemberRole } from '@/types/knowledge'

interface Department {
  id: string
  name: string
  label?: string
  supervisor_name?: string
  employee_count?: number
}

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

  const loc = (key: string, fallback: string) => {
    const v = t(key)
    return v && v !== key ? v : fallback
  }

  const [departments, setDepartments] = useState<Department[]>([])
  const [selectedDepartments, setSelectedDepartments] = useState<Department[]>([])
  const [role, setRole] = useState<MemberRole>('Reporter')
  const [loading, setLoading] = useState(false)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Clear state when dialog opens
  useEffect(() => {
    if (open) {
      setSearchQuery('')
      setDepartments([])
      setSelectedDepartments([])
      setError(null)
      setRole('Reporter')
    }
  }, [open])

  // Debounced search
  useEffect(() => {
    if (!open || !searchQuery.trim()) {
      setDepartments([])
      return
    }
    const timer = setTimeout(() => {
      performSearch(searchQuery)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery, open])

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
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to search departments'
      setError(message)
    } finally {
      setSearching(false)
    }
  }

  const isDepartmentSelected = (dept: Department) => selectedDepartments.some(d => d.id === dept.id)

  const handleToggleDepartment = (dept: Department) => {
    setSelectedDepartments(prev =>
      prev.some(d => d.id === dept.id) ? prev.filter(d => d.id !== dept.id) : [...prev, dept]
    )
    setSearchQuery('')
    setShowDropdown(false)
    setError(null)
  }

  const handleRemoveDepartment = (deptId: string) => {
    setSelectedDepartments(prev => prev.filter(d => d.id !== deptId))
  }

  const handleSubmit = async (e?: FormEvent) => {
    e?.preventDefault()
    setError(null)

    if (selectedDepartments.length === 0) {
      setError(loc('document.permission.selectDepartmentRequired', '请选择部门'))
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

      // Refresh the parent list because some adds did succeed.
      onSuccess?.()

      // Keep only failed departments selected so the user can retry directly.
      // Match by entity_id when the backend provides it; otherwise fall back
      // to keeping the whole selection (rare — only if backend omits entity_id).
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
      setError(
        loc(
          'document.permission.partialFailure',
          `${result.failed.length} 个部门添加失败：${failedNames}`
        )
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add department permission'
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  const resetForm = () => {
    setSelectedDepartments([])
    setRole('Reporter')
    setSearchQuery('')
    setShowDropdown(false)
    setError(null)
    setDepartments([])
  }

  const handleClose = () => {
    resetForm()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="w-5 h-5" />
            {loc('document.permission.addDepartment', '添加部门权限')}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Department search selector */}
          <div className="space-y-2">
            <label className="text-sm font-medium">
              {loc('document.permission.selectDepartment', '选择部门')}
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
                    if (searchQuery.trim()) setShowDropdown(true)
                  }}
                  placeholder={loc(
                    'document.permission.searchDepartmentPlaceholder',
                    '搜索部门...'
                  )}
                  className="pl-9"
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
                  ) : departments.length === 0 ? (
                    <div className="p-3 text-sm text-text-muted text-center">
                      {searchQuery.trim()
                        ? loc('document.permission.noDepartmentResults', '没有匹配的部门')
                        : loc('document.permission.searchDepartmentPlaceholder', '搜索部门...')}
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
                              {loc('document.permission.members', '人')}
                            </span>
                          )}
                        </button>
                      )
                    })
                  )}
                </div>
              )}
            </div>
            {/* Selected department chips */}
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

          {/* Role selector */}
          <div className="space-y-2">
            <label className="text-sm font-medium">
              {loc('document.permission.role.label', '角色')}
            </label>
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

          {/* Error message */}
          {error && (
            <div className="flex items-center gap-1.5 text-sm text-error bg-error/10 px-3 py-2 rounded-lg">
              <XCircle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={loading || selectedDepartments.length === 0}
            >
              {loading ? <Spinner className="w-4 h-4" /> : loc('document.permission.add', '添加')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
