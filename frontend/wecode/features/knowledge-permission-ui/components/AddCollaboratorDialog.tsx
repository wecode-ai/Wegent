// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useRef, useCallback, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { MemberRole } from '@/types/knowledge'
import type { CollaboratorType, SearchResultItem } from '../types'
import { CollaboratorSearchInput } from './CollaboratorSearchInput'
import { RoleDropdown } from './RoleDropdown'
import { buildSearchResultItemKey, buildResponseItemKey } from '../utils'
import {
  searchUsers,
  searchGroupsApi,
  searchDepartmentsApi,
  batchAddMembers,
  type BatchAddResponse,
} from '../api'

interface AddCollaboratorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kbId: number
  onSuccess: () => void
}

export function AddCollaboratorDialog({
  open,
  onOpenChange,
  kbId,
  onSuccess,
}: AddCollaboratorDialogProps) {
  const { t } = useTranslation('knowledge')
  const [type, setType] = useState<CollaboratorType>('user')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [selectedItems, setSelectedItems] = useState<SearchResultItem[]>([])
  const [role, setRole] = useState<MemberRole>('Reporter')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const typeRef = useRef(type)
  typeRef.current = type

  const doSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) {
      setResults([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      let items: SearchResultItem[] = []
      switch (typeRef.current) {
        case 'user':
          items = await searchUsers(searchQuery)
          break
        case 'group':
          items = await searchGroupsApi(searchQuery)
          break
        case 'department':
          items = await searchDepartmentsApi(searchQuery)
          break
      }
      setResults(items)
    } catch {
      setError(t('document.permission.searchFailed'))
    } finally {
      setLoading(false)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- error message uses t, stable enough

  // Debounced search — only fires when query text changes
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      doSearch(query)
    }, 300)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [query, doSearch])

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery('')
      setResults([])
      setSelectedItems([])
      setRole('Reporter')
      setError(null)
      setSuccessMessage(null)
      if (successTimerRef.current) clearTimeout(successTimerRef.current)
    }
  }, [open])

  // Auto-dismiss success message after 3 seconds
  useEffect(() => {
    if (successMessage) {
      if (successTimerRef.current) clearTimeout(successTimerRef.current)
      successTimerRef.current = setTimeout(() => setSuccessMessage(null), 3000)
    }
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current)
    }
  }, [successMessage])

  // Type change: clear results + immediate search with new type
  useEffect(() => {
    setResults([])
    if (query.trim()) {
      doSearch(query)
    }
  }, [type]) // eslint-disable-line react-hooks/exhaustive-deps -- only fire on type change; query/doSearch are read but must NOT be deps (would cause double-search)

  const handleToggleItem = (item: SearchResultItem) => {
    setSelectedItems(prev => {
      const exists = prev.some(s => s.id === item.id && s.type === item.type)
      if (exists) {
        return prev.filter(s => s.id !== item.id || s.type !== item.type)
      }
      return [...prev, item]
    })
  }

  const handleSubmit = async () => {
    if (selectedItems.length === 0) return
    setSubmitting(true)
    setError(null)
    try {
      const members = selectedItems.map(item => {
        if (item.type === 'user') {
          return { user_id: item.id as number, role }
        } else if (item.type === 'group') {
          return {
            user_id: 0,
            role,
            entity_type: 'namespace',
            entity_id: String(item.id),
            entity_display_name: item.name,
          }
        } else {
          return {
            user_id: 0,
            role,
            entity_type: 'org_department',
            entity_id: item.id as string,
            entity_display_name: item.name,
          }
        }
      })
      const result: BatchAddResponse = await batchAddMembers(kbId, members)

      // Build a lookup map: itemKey -> item name
      const itemMap = new Map<string, string>()
      selectedItems.forEach(item => {
        itemMap.set(buildSearchResultItemKey(item), item.name)
      })

      // Resolve succeeded item keys
      const succeededKeys = new Set<string>()
      result.succeeded?.forEach(s => {
        succeededKeys.add(buildResponseItemKey(s))
      })

      if (succeededKeys.size > 0) {
        // Collect succeeded item names for display
        const succeededNames: string[] = []
        selectedItems.forEach(item => {
          if (succeededKeys.has(buildSearchResultItemKey(item))) succeededNames.push(item.name)
        })
        setSuccessMessage(t('document.permission.addSucceeded', { names: succeededNames.join(t('document.permission.separator')) }))

        onSuccess()
        setSelectedItems(prev =>
          prev.filter(item => !succeededKeys.has(buildSearchResultItemKey(item)))
        )
      }

      if (result.failed?.length > 0) {
        // Group errors by type and resolve names
        const errorGroups: Record<string, string[]> = {}
        result.failed.forEach(f => {
          const name = itemMap.get(buildResponseItemKey(f)) || t('common:unknown', { defaultValue: '未知' })
          const errMsg = f.error || t('document.permission.addFailed')
          if (!errorGroups[errMsg]) errorGroups[errMsg] = []
          errorGroups[errMsg].push(name)
        })
        const errorLines = Object.entries(errorGroups).map(
          ([err, names]) => `${names.join(t('document.permission.separator'))}${t('document.permission.colon')}${err}`
        )
        setError(errorLines.join(t('document.permission.semicolon')))
      } else if (result.succeeded?.length > 0) {
        onOpenChange(false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('document.permission.addFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{t('document.permission.addCollaborator')}</DialogTitle>
          <DialogDescription />
        </DialogHeader>

        <div className="space-y-4">
          <CollaboratorSearchInput
            type={type}
            onTypeChange={setType}
            query={query}
            onQueryChange={setQuery}
            onSearch={() => doSearch(query)}
            results={results}
            selectedItems={selectedItems}
            onToggleItem={handleToggleItem}
            loading={loading}
          />

          {selectedItems.length > 0 && (
            <div className="space-y-2">
              <span className="text-xs text-text-secondary" data-testid="selected-count-display">{t('document.permission.selectedCount', { count: selectedItems.length })}</span>
              <div className="flex flex-wrap gap-1.5">
                {selectedItems.map(item => (
                  <span
                    key={`selected-${item.type}-${item.id}`}
                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-surface rounded-md text-xs text-text-primary border border-border"
                  >
                    {item.name}
                    <button
                      className="ml-0.5 text-text-muted hover:text-red-500 transition-colors"
                      onClick={() => handleToggleItem(item)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {selectedItems.length > 0 && (
            <div className="flex items-center gap-2 pt-1 border-t border-border">
              <span className="text-sm text-text-secondary">
                {t('document.permission.selectRole', { defaultValue: '权限角色' })}:
              </span>
              <RoleDropdown value={role} onValueChange={setRole} />
            </div>
          )}

          {error && <div className="text-sm text-red-500">{error}</div>}

          {successMessage && <div className="text-sm text-green-600">{successMessage}</div>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:actions.cancel', { defaultValue: '取消' })}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={selectedItems.length === 0 || submitting}
            data-testid="add-collaborators-button"
          >
            {submitting ? t('document.permission.adding') : t('document.permission.addWithCount', { count: selectedItems.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
