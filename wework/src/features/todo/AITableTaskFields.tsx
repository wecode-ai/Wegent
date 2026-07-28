import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, ExternalLink, Loader2, Pencil, X } from 'lucide-react'

import type { AITableApi, AITableField, AITableRecord } from '@/api/aitable'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { cn } from '@/lib/utils'

const READONLY_TYPES = new Set([
  'formula',
  'creator',
  'createdTime',
  'lastModifier',
  'lastModifiedTime',
  'autoNumber',
  'primaryDoc',
])
const EDITABLE_TYPES = new Set([
  'text',
  'singleLineText',
  'multiLineText',
  'number',
  'singleSelect',
  'date',
  'checkbox',
  'url',
  'phone',
  'email',
])

function textValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(', ')
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    return String(object.name ?? object.title ?? object.text ?? object.link ?? '')
  }
  return String(value)
}

function fieldOptions(field: AITableField): string[] {
  return Array.isArray(field.config?.options)
    ? field.config.options
        .map(option =>
          typeof option === 'object' && option !== null && 'name' in option
            ? String(option.name)
            : ''
        )
        .filter(Boolean)
    : []
}

function editableField(field: AITableField): boolean {
  return EDITABLE_TYPES.has(field.type) && !READONLY_TYPES.has(field.type) && !field.ai_config
}

function FieldRow({
  field,
  value,
  canEdit,
  onSave,
}: {
  field: AITableField
  value: unknown
  canEdit: boolean
  onSave: (value: unknown) => Promise<void>
}) {
  const text = textValue(value)
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const [saving, setSaving] = useState(false)
  const long = text.length > 160 || text.includes('\n')
  const options = fieldOptions(field)

  async function save(next: unknown = draft) {
    let normalized = next
    if (field.type === 'number' && typeof next === 'string' && next.trim()) {
      normalized = Number(next)
    }
    if (field.type === 'url' && typeof next === 'string') {
      normalized =
        typeof value === 'object' && value !== null
          ? { ...(value as Record<string, unknown>), link: next }
          : { text: next, link: next }
    }
    setSaving(true)
    try {
      await onSave(normalized)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-4 border-t border-border py-3 first:border-t-0">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium" title={field.name}>
          {field.name}
        </div>
        <div className="mt-0.5 text-xs text-text-muted">
          {field.type}
          {!editableField(field) ? ' · 只读' : ''}
        </div>
      </div>
      <div className="group min-w-0">
        {editing ? (
          <div className="space-y-2">
            {field.type === 'singleSelect' && options.length > 0 ? (
              <select
                autoFocus
                data-testid={`aitable-detail-edit-${field.id}`}
                value={draft}
                onChange={event => setDraft(event.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-background px-2 text-sm outline-none focus:border-focus"
              >
                <option value="">—</option>
                {options.map(option => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <textarea
                autoFocus
                data-testid={`aitable-detail-edit-${field.id}`}
                value={draft}
                onChange={event => setDraft(event.target.value)}
                rows={long || expanded ? 8 : 2}
                className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm leading-6 outline-none focus:border-focus"
              />
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setDraft(text)
                  setEditing(false)
                }}
                className="flex h-8 items-center gap-1 rounded-lg px-2.5 text-sm text-text-secondary hover:bg-muted"
              >
                <X className="h-3.5 w-3.5" /> 取消
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void save()}
                className="h-8 rounded-lg bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-40"
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 items-start gap-2">
            <div className="min-w-0 flex-1">
              {field.type === 'checkbox' ? (
                <input
                  type="checkbox"
                  checked={value === true || value === 'true'}
                  disabled={!canEdit || saving}
                  onChange={event => void save(event.target.checked)}
                  className="h-4 w-4"
                />
              ) : field.type === 'url' && typeof value === 'object' && value !== null ? (
                <a
                  href={String((value as Record<string, unknown>).link ?? '')}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex max-w-full items-center gap-1 break-all text-sm text-focus hover:underline"
                >
                  {text || '打开链接'} <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                </a>
              ) : (
                <div
                  data-testid={`aitable-detail-value-${field.id}`}
                  className={cn(
                    'whitespace-pre-wrap break-words text-sm leading-6 text-text-secondary',
                    long && !expanded && 'line-clamp-3'
                  )}
                >
                  {text || '—'}
                </div>
              )}
              {long && (
                <button
                  type="button"
                  data-testid={`aitable-detail-expand-${field.id}`}
                  onClick={() => setExpanded(current => !current)}
                  className="mt-1 inline-flex h-7 items-center gap-1 rounded-md text-xs text-text-muted hover:text-text-primary"
                >
                  {expanded ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                  {expanded ? '收起' : '展开全部'}
                </button>
              )}
            </div>
            {canEdit && editableField(field) && field.type !== 'checkbox' && (
              <button
                type="button"
                data-testid={`aitable-detail-edit-button-${field.id}`}
                onClick={() => setEditing(true)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted opacity-0 hover:bg-muted hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100"
                aria-label={`编辑${field.name}`}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function AITableTaskFields({
  api,
  project,
  item,
}: {
  api: AITableApi
  project: CloudProject
  item: CloudLoopItem
}) {
  const [fields, setFields] = useState<AITableField[]>([])
  const [record, setRecord] = useState<AITableRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const recordId = item.id.split(':').at(-1) ?? ''

  useEffect(() => {
    let active = true
    if (!api.getRecord) return
    void Promise.all([api.describe(project.id), api.getRecord(project.id, recordId)])
      .then(([description, nextRecord]) => {
        if (!active) return
        setFields(description.fields)
        setRecord(nextRecord)
      })
      .catch(cause => active && setError(cause instanceof Error ? cause.message : '字段加载失败'))
    return () => {
      active = false
    }
  }, [api, project.id, recordId])

  async function updateField(fieldId: string, value: unknown) {
    const updated = await api.updateRecord(project.id, recordId, { [fieldId]: value })
    setRecord(current =>
      current
        ? { ...current, cells: { ...current.cells, [fieldId]: updated.cells[fieldId] ?? value } }
        : current
    )
  }

  return (
    <section className="mt-8 border-t border-border pt-6" data-testid="aitable-task-fields">
      <h2 className="text-base font-medium">钉钉字段</h2>
      <p className="mt-1 text-xs text-text-muted">完整展示当前记录；修改会直接写回钉钉多维表格。</p>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      {!record && !error ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> 加载字段…
        </div>
      ) : null}
      {record ? (
        <div className="mt-3">
          {fields.map(field => (
            <FieldRow
              key={field.id}
              field={field}
              value={record.cells[field.id]}
              canEdit={item.can_edit !== false}
              onSave={value => updateField(field.id, value)}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}
