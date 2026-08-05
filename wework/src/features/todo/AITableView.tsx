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
import {
  AllCommunityModule,
  ModuleRegistry,
  colorSchemeVariable,
  themeQuartz,
  type ColDef,
  type ICellRendererParams,
  type IHeaderParams,
} from 'ag-grid-community'
import { AgGridReact } from 'ag-grid-react'
import { Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'

import type { AITableApi, AITableDescription, AITableField, AITableRecord } from '@/api/aitable'
import type { CloudProject } from '@/api/deliveries'

ModuleRegistry.registerModules([AllCommunityModule])

const aitableGridTheme = themeQuartz.withPart(colorSchemeVariable).withParams({
  accentColor: 'rgb(var(--color-primary))',
  backgroundColor: 'rgb(var(--color-bg-base))',
  borderColor: 'rgb(var(--color-border))',
  browserColorScheme: 'inherit',
  cellHorizontalPadding: 12,
  columnBorder: true,
  fontFamily: 'var(--font-ui)',
  fontSize: 'var(--text-sm)',
  foregroundColor: 'rgb(var(--color-text-primary))',
  headerBackgroundColor: 'rgb(var(--color-muted))',
  headerFontSize: 'var(--text-sm)',
  headerFontWeight: 500,
  headerTextColor: 'rgb(var(--color-text-secondary))',
  oddRowBackgroundColor: 'rgb(var(--color-bg-base))',
  rowBorder: true,
  rowHoverColor: 'rgb(var(--color-muted) / 0.4)',
  selectedRowBackgroundColor: 'rgb(var(--color-primary) / 0.08)',
  spacing: 4,
  wrapperBorder: false,
})

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

function gridValue(field: AITableField, value: unknown): string | number | Date | null {
  if (value === null || value === undefined || value === '') return null
  if (field.type === 'number') {
    const number = typeof value === 'number' ? value : Number(cellText(value))
    return Number.isFinite(number) ? number : cellText(value)
  }
  if (field.type === 'date') {
    const date = new Date(typeof value === 'number' ? value : cellText(value))
    return Number.isNaN(date.getTime()) ? cellText(value) : date
  }
  return cellText(value)
}

function selectValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => cellText(item)).filter(Boolean)
  const single = cellText(value)
  return single ? [single] : []
}

function editorText(field: AITableField, value: unknown): string {
  if (field.type !== 'date') return cellText(value)
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString().slice(0, 10)
  }
  const text = cellText(value)
  const match = text.match(/^\d{4}-\d{2}-\d{2}/)
  return match?.[0] ?? text
}

function viewValue(view: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = view[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function viewColumns(view: Record<string, unknown> | undefined): string[] {
  const columns = view?.columns ?? view?.fieldIds
  return Array.isArray(columns)
    ? columns.filter((column): column is string => typeof column === 'string')
    : []
}

function viewHiddenFields(view: Record<string, unknown> | undefined): Set<string> {
  const custom = view?.custom
  if (typeof custom !== 'object' || custom === null) return new Set()
  const hidden = (custom as Record<string, unknown>).hiddenFields
  if (typeof hidden !== 'object' || hidden === null) return new Set()
  return new Set(
    Object.entries(hidden as Record<string, unknown>)
      .filter(([, value]) => value === true)
      .map(([fieldId]) => fieldId)
  )
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
  const displayText = editorText(field, raw)

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
          setDraft(displayText)
          setEditing(true)
        }}
        className="block w-full truncate rounded px-1 py-0.5 text-left text-sm hover:bg-muted"
        title={displayText}
      >
        {displayText || <span className="text-text-muted">—</span>}
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

interface GridCellContext {
  canEditRecords: boolean
  commitCell: (record: AITableRecord, fieldId: string, value: unknown) => Promise<void>
}

function GridCellRenderer({ data, colDef, context }: ICellRendererParams<AITableRecord>) {
  const record = data
  const field = colDef?.context as AITableField | undefined
  const gridContext = context as GridCellContext
  if (!record || !field) return null

  return (
    <CellEditor
      field={gridContext.canEditRecords ? field : { ...field, type: 'readonly' }}
      record={record}
      onCommit={(fieldId, value) => gridContext.commitCell(record, fieldId, value)}
    />
  )
}

interface FieldHeaderContext {
  canManageFields: boolean
  removeField: (field: AITableField) => Promise<void>
}

function FieldHeader({ displayName, column, context }: IHeaderParams<AITableRecord>) {
  const field = column.getColDef().context as AITableField | undefined
  const headerContext = context as FieldHeaderContext

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      <span className="truncate" title={field ? `${field.name} (${field.type})` : displayName}>
        {displayName}
      </span>
      {field && headerContext.canManageFields ? (
        <button
          type="button"
          data-testid={`aitable-field-delete-${field.id}`}
          onClick={event => {
            event.stopPropagation()
            void headerContext.removeField(field)
          }}
          className="shrink-0 text-text-muted hover:text-destructive"
          title="删除字段"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      ) : null}
    </span>
  )
}

interface RecordActionsContext {
  canEditRecords: boolean
  removeRecord: (record: AITableRecord) => Promise<void>
}

function RecordActions({ data, context }: ICellRendererParams<AITableRecord>) {
  const record = data
  const actionContext = context as RecordActionsContext
  if (!record || !actionContext.canEditRecords) return null

  return (
    <button
      type="button"
      data-testid={`aitable-record-delete-${record.id}`}
      onClick={() => void actionContext.removeRecord(record)}
      className="text-text-muted hover:text-destructive"
      title="删除记录"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
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
  const [selectedViewId, setSelectedViewId] = useState(project.provider_config.view_id ?? '')
  const canManageFields = ['Owner', 'Maintainer', 'Developer'].includes(
    project.access_role ?? 'Owner'
  )
  const canEditRecords = canManageFields

  const load = useCallback(
    async (keyword?: string, viewId = selectedViewId) => {
      setLoading(true)
      setError(null)
      try {
        await api.configureProject(project)
        const [schema, page] = await Promise.all([
          api.describe(project.id),
          api.listRecords(project.id, { query: keyword, limit: 100, viewId: viewId || undefined }),
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
    [api, project, selectedViewId]
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setError(null)
      try {
        await api.configureProject(project)
        const initialViewId = project.provider_config.view_id ?? ''
        const schema = await api.describe(project.id)
        const resolvedViewId =
          initialViewId ||
          (schema.views?.length ? viewValue(schema.views[0], ['viewId', 'view_id', 'id']) : '')
        const page = await api.listRecords(project.id, {
          limit: 100,
          viewId: resolvedViewId || undefined,
        })
        if (cancelled) return
        setDescription(schema)
        setSelectedViewId(resolvedViewId)
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
  const selectedView = useMemo(
    () =>
      description?.views?.find(
        view => viewValue(view, ['viewId', 'view_id', 'id']) === selectedViewId
      ),
    [description, selectedViewId]
  )
  const visibleFields = useMemo(() => {
    const columns = viewColumns(selectedView)
    const hidden = viewHiddenFields(selectedView)
    const available = fields.filter(field => !hidden.has(field.id))
    if (!columns.length) return available
    const positions = new Map(columns.map((fieldId, index) => [fieldId, index]))
    return available
      .filter(field => positions.has(field.id))
      .sort((left, right) => positions.get(left.id)! - positions.get(right.id)!)
  }, [fields, selectedView])

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
        viewId: selectedViewId || undefined,
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

  const columnDefs = useMemo<ColDef<AITableRecord>[]>(
    () => [
      ...visibleFields.map((field): ColDef<AITableRecord> => {
        const filter =
          field.type === 'number'
            ? 'agNumberColumnFilter'
            : field.type === 'date'
              ? 'agDateColumnFilter'
              : 'agTextColumnFilter'
        return {
          colId: field.id,
          context: field,
          filter,
          filterValueGetter: params => gridValue(field, params.data?.cells[field.id]),
          headerComponentParams: { innerHeaderComponent: FieldHeader },
          headerName: field.name,
          minWidth: 160,
          sortable: true,
          suppressHeaderMenuButton: false,
          valueGetter: params => gridValue(field, params.data?.cells[field.id]),
          cellRenderer: GridCellRenderer,
        }
      }),
      {
        colId: 'record-actions',
        cellRenderer: RecordActions,
        filter: false,
        headerName: '',
        maxWidth: 48,
        minWidth: 48,
        pinned: 'right',
        resizable: false,
        sortable: false,
        suppressHeaderMenuButton: true,
      },
    ],
    [visibleFields]
  )

  const gridContext = {
    canEditRecords,
    canManageFields,
    commitCell,
    removeField,
    removeRecord,
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

      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="flex h-32 items-center justify-center text-text-muted">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="h-full" data-testid="aitable-grid">
            <AgGridReact<AITableRecord>
              columnDefs={columnDefs}
              context={gridContext}
              defaultColDef={{
                flex: 1,
                resizable: true,
                suppressMovable: false,
              }}
              getRowId={params => params.data.id}
              headerHeight={40}
              overlayNoRowsTemplate="暂无记录"
              rowData={records}
              rowHeight={40}
              theme={aitableGridTheme}
            />
          </div>
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
