// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Dynamic DingTalk AI Table view.
//
// Renders the live field schema and records so users never need to open the
// DingTalk app. Known field types get inline editors; formula/system/AI and
// unknown types stay read-only and their raw payloads round-trip untouched.
// Field management (add/rename/delete) requires a Developer-or-higher role.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'

import type { AITableApi, AITableDescription, AITableField, AITableRecord } from '@/api/aitable'
import type { CloudProject } from '@/api/deliveries'

const EDITABLE_TYPES = new Set([
  'text',
  'singleLineText',
  'multiLineText',
  'number',
  'singleSelect',
  'multipleSelect',
  'date',
  'checkbox',
  'url',
  'user',
  'phone',
  'email',
])

const READONLY_TYPES = new Set([
  'formula',
  'creator',
  'createdTime',
  'lastModifier',
  'lastModifiedTime',
  'autoNumber',
  'primaryDoc',
])

function isEditable(field: AITableField): boolean {
  if (READONLY_TYPES.has(field.type)) return false
  if (field.ai_config) return false
  return EDITABLE_TYPES.has(field.type)
}

function fieldOptions(field: AITableField): Array<{ name: string }> {
  const options = field.config?.options
  return Array.isArray(options)
    ? options.filter(
        (option): option is { name: string } =>
          typeof option === 'object' && option !== null && 'name' in option
      )
    : []
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === 'object' && item !== null) {
          const record = item as Record<string, unknown>
          return String(record.name ?? record.title ?? record.text ?? '')
        }
        return String(item)
      })
      .filter(Boolean)
      .join(', ')
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return String(record.name ?? record.title ?? record.text ?? '')
  }
  return String(value)
}

function selectValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => cellText(item)).filter(Boolean)
  const single = cellText(value)
  return single ? [single] : []
}

interface CellEditorProps {
  field: AITableField
  record: AITableRecord
  onCommit: (fieldId: string, value: unknown) => Promise<void>
}

function CellEditor({ field, record, onCommit }: CellEditorProps) {
  const raw = record.cells[field.id]
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const type = field.type

  async function commit(value: unknown) {
    setSaving(true)
    try {
      await onCommit(field.id, value)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  if (!isEditable(field)) {
    return (
      <span className="block truncate text-text-secondary" title={cellText(raw)}>
        {cellText(raw) || '—'}
      </span>
    )
  }

  if (type === 'checkbox') {
    return (
      <input
        type="checkbox"
        data-testid={`aitable-cell-checkbox-${record.id}-${field.id}`}
        checked={raw === true || raw === 'true'}
        disabled={saving}
        onChange={event => void commit(event.target.checked)}
        className="h-4 w-4 accent-primary"
      />
    )
  }

  if (type === 'singleSelect') {
    return (
      <select
        data-testid={`aitable-cell-select-${record.id}-${field.id}`}
        value={cellText(raw)}
        disabled={saving}
        onChange={event => void commit(event.target.value)}
        className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-sm hover:border-border focus:border-primary focus:outline-none"
      >
        <option value="">—</option>
        {fieldOptions(field).map(option => (
          <option key={option.name} value={option.name}>
            {option.name}
          </option>
        ))}
      </select>
    )
  }

  if (type === 'multipleSelect') {
    const selected = selectValues(raw)
    return (
      <select
        multiple
        data-testid={`aitable-cell-multiselect-${record.id}-${field.id}`}
        value={selected}
        disabled={saving}
        onChange={event =>
          void commit(Array.from(event.target.selectedOptions, option => option.value))
        }
        className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-sm hover:border-border focus:border-primary focus:outline-none"
      >
        {fieldOptions(field).map(option => (
          <option key={option.name} value={option.name}>
            {option.name}
          </option>
        ))}
      </select>
    )
  }

  const inputType = type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'
  if (!editing) {
    return (
      <button
        type="button"
        data-testid={`aitable-cell-edit-${record.id}-${field.id}`}
        onClick={() => {
          setDraft(cellText(raw))
          setEditing(true)
        }}
        className="block w-full truncate rounded px-1 py-0.5 text-left text-sm hover:bg-muted"
        title={cellText(raw)}
      >
        {cellText(raw) || <span className="text-text-muted">—</span>}
      </button>
    )
  }
  return (
    <input
      autoFocus
      type={inputType}
      data-testid={`aitable-cell-input-${record.id}-${field.id}`}
      value={draft}
      disabled={saving}
      onChange={event => setDraft(event.target.value)}
      onBlur={() => void commit(type === 'number' && draft !== '' ? Number(draft) : draft)}
      onKeyDown={event => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') setEditing(false)
      }}
      className="w-full rounded border border-primary bg-background px-1 py-0.5 text-sm focus:outline-none"
    />
  )
}

export function AITableView({ api, project }: { api: AITableApi; project: CloudProject }) {
  const [description, setDescription] = useState<AITableDescription | null>(null)
  const [records, setRecords] = useState<AITableRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [newFieldName, setNewFieldName] = useState('')
  const [newFieldType, setNewFieldType] = useState('text')
  const [addingField, setAddingField] = useState(false)
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [mutationBusy, setMutationBusy] = useState(false)
  const canManageFields = ['Owner', 'Maintainer', 'Developer'].includes(
    project.access_role ?? 'Owner'
  )
  const canEditRecords = canManageFields

  const load = useCallback(
    async (keyword?: string) => {
      setLoading(true)
      setError(null)
      try {
        await api.configureProject(project)
        const [schema, page] = await Promise.all([
          api.describe(project.id),
          api.listRecords(project.id, { query: keyword, limit: 100 }),
        ])
        setDescription(schema)
        setRecords(page.items)
        setCursor(page.cursor)
        setHasMore(page.has_more)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '加载表格失败')
      } finally {
        setLoading(false)
      }
    },
    [api, project]
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setError(null)
      try {
        await api.configureProject(project)
        const [schema, page] = await Promise.all([
          api.describe(project.id),
          api.listRecords(project.id, { limit: 100 }),
        ])
        if (cancelled) return
        setDescription(schema)
        setRecords(page.items)
        setCursor(page.cursor)
        setHasMore(page.has_more)
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '加载表格失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api, project])

  const fields = useMemo(() => description?.fields ?? [], [description])

  async function commitCell(record: AITableRecord, fieldId: string, value: unknown) {
    setError(null)
    try {
      const updated = await api.updateRecord(project.id, record.id, { [fieldId]: value })
      setRecords(current =>
        current.map(item =>
          item.id === record.id ? { ...item, cells: { ...item.cells, ...updated.cells } } : item
        )
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存单元格失败')
    }
  }

  async function addRecord() {
    setMutationBusy(true)
    setError(null)
    try {
      const seed = fields.find(field => isEditable(field))
      if (!seed) throw new Error('当前表格没有可写字段')
      const created = await api.createRecord(project.id, { [seed.id]: '' })
      setRecords(current => [...current, created])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '新增记录失败')
    } finally {
      setMutationBusy(false)
    }
  }

  async function removeRecord(record: AITableRecord) {
    if (!window.confirm('确定删除这条钉钉表格记录吗？此操作无法撤销。')) return
    setMutationBusy(true)
    setError(null)
    try {
      await api.deleteRecord(project.id, record.id)
      setRecords(current => current.filter(item => item.id !== record.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除记录失败')
    } finally {
      setMutationBusy(false)
    }
  }

  async function loadMore() {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    setError(null)
    try {
      const page = await api.listRecords(project.id, {
        query: query || undefined,
        limit: 100,
        cursor,
      })
      setRecords(current => [...current, ...page.items])
      setCursor(page.cursor)
      setHasMore(page.has_more)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载更多记录失败')
    } finally {
      setLoadingMore(false)
    }
  }

  async function addField() {
    const name = newFieldName.trim()
    if (!name) return
    setAddingField(true)
    setError(null)
    try {
      await api.createField(project.id, { name, type: newFieldType })
      setNewFieldName('')
      await load(query || undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '新增字段失败')
    } finally {
      setAddingField(false)
    }
  }

  async function removeField(field: AITableField) {
    if (!window.confirm(`确定删除字段“${field.name}”吗？此操作无法撤销。`)) return
    setError(null)
    try {
      await api.deleteField(project.id, field.id)
      await load(query || undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除字段失败')
    }
  }

  return (
    <div className="flex h-full flex-col" data-testid="aitable-view">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <input
          type="search"
          data-testid="aitable-search"
          placeholder="搜索记录…"
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') void load(query || undefined)
          }}
          className="h-8 w-56 rounded-md border border-border bg-background px-2 text-sm focus:border-primary focus:outline-none"
        />
        <button
          type="button"
          data-testid="aitable-refresh"
          onClick={() => void load(query || undefined)}
          className="flex h-8 items-center gap-1 rounded-md border border-border px-2 text-sm text-text-secondary hover:bg-muted"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          刷新
        </button>
        <span className="flex-1" />
        {canEditRecords ? (
          <button
            type="button"
            data-testid="aitable-add-record"
            disabled={mutationBusy}
            onClick={() => void addRecord()}
            className="flex h-8 items-center gap-1 rounded-md bg-text-primary px-2.5 text-sm text-background hover:opacity-80 disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
            新增记录
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-32 items-center justify-center text-text-muted">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 bg-muted">
              <tr>
                {fields.map(field => (
                  <th
                    key={field.id}
                    className="border-b border-border px-3 py-2 text-left font-medium text-text-secondary"
                  >
                    <span className="flex items-center gap-1">
                      <span className="truncate" title={`${field.name} (${field.type})`}>
                        {field.name}
                      </span>
                      {canManageFields ? (
                        <button
                          type="button"
                          data-testid={`aitable-field-delete-${field.id}`}
                          onClick={() => void removeField(field)}
                          className="text-text-muted hover:text-destructive"
                          title="删除字段"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      ) : null}
                    </span>
                  </th>
                ))}
                <th className="w-10 border-b border-border" />
              </tr>
            </thead>
            <tbody>
              {records.map(record => (
                <tr key={record.id} className="border-b border-border/60 hover:bg-muted/40">
                  {fields.map(field => (
                    <td key={field.id} className="max-w-56 px-3 py-1.5 align-top">
                      <CellEditor
                        field={canEditRecords ? field : { ...field, type: 'readonly' }}
                        record={record}
                        onCommit={(fieldId, value) => commitCell(record, fieldId, value)}
                      />
                    </td>
                  ))}
                  <td className="px-2 py-1.5 text-right">
                    {canEditRecords ? (
                      <button
                        type="button"
                        data-testid={`aitable-record-delete-${record.id}`}
                        onClick={() => void removeRecord(record)}
                        className="text-text-muted hover:text-destructive"
                        title="删除记录"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {records.length === 0 ? (
                <tr>
                  <td
                    colSpan={fields.length + 1}
                    className="px-3 py-10 text-center text-text-muted"
                  >
                    暂无记录
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        )}
      </div>

      {hasMore ? (
        <div className="flex justify-center border-t border-border px-4 py-2">
          <button
            type="button"
            data-testid="aitable-load-more"
            disabled={loadingMore}
            onClick={() => void loadMore()}
            className="h-8 rounded-md px-3 text-sm text-text-secondary hover:bg-muted disabled:opacity-40"
          >
            {loadingMore ? '加载中…' : '加载更多'}
          </button>
        </div>
      ) : null}

      {canManageFields ? (
        <div className="flex items-center gap-2 border-t border-border px-4 py-2">
          <input
            type="text"
            data-testid="aitable-field-name"
            placeholder="新字段名称"
            value={newFieldName}
            onChange={event => setNewFieldName(event.target.value)}
            className="h-8 w-48 rounded-md border border-border bg-background px-2 text-sm focus:border-primary focus:outline-none"
          />
          <select
            data-testid="aitable-field-type"
            value={newFieldType}
            onChange={event => setNewFieldType(event.target.value)}
            className="h-8 rounded-md border border-border bg-background px-2 text-sm focus:border-primary focus:outline-none"
          >
            <option value="text">文本</option>
            <option value="number">数字</option>
            <option value="singleSelect">单选</option>
            <option value="multipleSelect">多选</option>
            <option value="date">日期</option>
            <option value="checkbox">勾选</option>
            <option value="url">链接</option>
            <option value="user">成员</option>
          </select>
          <button
            type="button"
            data-testid="aitable-add-field"
            onClick={() => void addField()}
            disabled={addingField || !newFieldName.trim()}
            className="flex h-8 items-center gap-1 rounded-md border border-border px-2.5 text-sm text-text-secondary hover:bg-muted disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            新增字段
          </button>
        </div>
      ) : null}
    </div>
  )
}
