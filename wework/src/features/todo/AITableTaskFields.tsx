import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, ExternalLink, Loader2, Pencil, Sparkles, X } from 'lucide-react'

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
  'richText',
  'number',
  'singleSelect',
  'date',
  'checkbox',
  'url',
  'phone',
  'email',
])
const CONTENT_TYPES = new Set(['multiLineText', 'richText'])
const PROPERTY_LIMIT = 8

function textValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(', ')
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    if (typeof object.markdown === 'string') return object.markdown
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

function contentField(field: AITableField, value: unknown, descriptionFieldId?: string): boolean {
  const text = textValue(value)
  return (
    field.id === descriptionFieldId ||
    CONTENT_TYPES.has(field.type) ||
    text.includes('\n') ||
    text.length > 140
  )
}

function normalizeValue(field: AITableField, current: unknown, next: unknown): unknown {
  if (field.type === 'number' && typeof next === 'string' && next.trim()) return Number(next)
  if (field.type === 'url' && typeof next === 'string') {
    return typeof current === 'object' && current !== null
      ? { ...(current as Record<string, unknown>), link: next }
      : { text: next, link: next }
  }
  if (field.type === 'richText' && typeof next === 'string') return { markdown: next }
  return next
}

function FieldValue({ field, value }: { field: AITableField; value: unknown }) {
  const text = textValue(value)
  if (field.type === 'checkbox')
    return <span>{value === true || value === 'true' ? '是' : '否'}</span>
  if (field.type === 'url' && typeof value === 'object' && value !== null) {
    return (
      <a
        href={String((value as Record<string, unknown>).link ?? '')}
        target="_blank"
        rel="noreferrer"
        className="inline-flex max-w-full items-center gap-1 break-all text-focus hover:underline"
      >
        {text || '打开链接'} <ExternalLink className="h-3.5 w-3.5 shrink-0" />
      </a>
    )
  }
  return <span className="whitespace-pre-wrap break-words">{text || '—'}</span>
}

function FieldEditor({
  field,
  value,
  expanded = false,
  onCancel,
  onSave,
}: {
  field: AITableField
  value: unknown
  expanded?: boolean
  onCancel: () => void
  onSave: (value: unknown) => Promise<void>
}) {
  const [draft, setDraft] = useState(textValue(value))
  const [saving, setSaving] = useState(false)
  const options = fieldOptions(field)

  async function save(next: unknown = draft) {
    setSaving(true)
    try {
      await onSave(normalizeValue(field, value, next))
      onCancel()
    } finally {
      setSaving(false)
    }
  }

  return (
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
      ) : field.type === 'checkbox' ? (
        <label className="flex h-9 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft === 'true' || value === true}
            onChange={event => setDraft(String(event.target.checked))}
          />
          已选中
        </label>
      ) : (
        <textarea
          autoFocus
          data-testid={`aitable-detail-edit-${field.id}`}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          rows={expanded ? 8 : 2}
          className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm leading-6 outline-none focus:border-focus"
        />
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex h-8 items-center gap-1 rounded-lg px-2.5 text-sm text-text-secondary hover:bg-muted"
        >
          <X className="h-3.5 w-3.5" /> 取消
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void save(field.type === 'checkbox' ? draft === 'true' : draft)}
          className="h-8 rounded-lg bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-40"
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}

function ContentBlock({
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
  const long = text.length > 140 || text.split('\n').length > 4

  return (
    <article
      className="border-t border-border py-5 first:border-t-0"
      data-testid={`aitable-content-${field.id}`}
    >
      <header className="mb-2 flex items-center gap-2">
        {field.ai_config ? <Sparkles className="h-4 w-4 text-text-muted" /> : null}
        <h3 className="text-sm font-medium">{field.name}</h3>
        {!editableField(field) ? (
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-text-muted">只读</span>
        ) : null}
        <span className="flex-1" />
        {canEdit && editableField(field) && !editing ? (
          <button
            type="button"
            data-testid={`aitable-detail-edit-button-${field.id}`}
            onClick={() => setEditing(true)}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-muted hover:bg-muted hover:text-text-primary"
          >
            <Pencil className="h-3.5 w-3.5" /> 编辑
          </button>
        ) : null}
      </header>
      {editing ? (
        <FieldEditor
          field={field}
          value={value}
          expanded
          onCancel={() => setEditing(false)}
          onSave={onSave}
        />
      ) : (
        <>
          <div
            data-testid={`aitable-detail-value-${field.id}`}
            className={cn(
              'text-sm leading-6 text-text-secondary',
              long && !expanded && 'line-clamp-4'
            )}
          >
            <FieldValue field={field} value={value} />
          </div>
          {long ? (
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
          ) : null}
        </>
      )}
    </article>
  )
}

function PropertyItem({
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
  const [editing, setEditing] = useState(false)
  return (
    <div className="group min-w-0 border-t border-border py-2.5 first:border-t-0">
      <div className="flex min-w-0 items-start gap-3">
        <span className="w-24 shrink-0 truncate text-xs text-text-muted" title={field.name}>
          {field.name}
        </span>
        <div className="min-w-0 flex-1 text-sm text-text-secondary">
          {editing ? (
            <FieldEditor
              field={field}
              value={value}
              onCancel={() => setEditing(false)}
              onSave={onSave}
            />
          ) : (
            <FieldValue field={field} value={value} />
          )}
        </div>
        {canEdit && editableField(field) && !editing ? (
          <button
            type="button"
            data-testid={`aitable-detail-edit-button-${field.id}`}
            onClick={() => setEditing(true)}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted opacity-0 hover:bg-muted hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100"
            aria-label={`编辑${field.name}`}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        ) : null}
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
  const [moreOpen, setMoreOpen] = useState(false)
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

  const layout = useMemo(() => {
    if (!record) return { content: [], properties: [], more: [] }
    const mapping = project.provider_config?.board_mapping ?? {}
    const titleFieldId = mapping.title_field_id
    const descriptionFieldId = mapping.description_field_id
    const candidates = fields.filter(field => field.id !== titleFieldId)
    const content = candidates.filter(field =>
      contentField(field, record.cells[field.id], descriptionFieldId)
    )
    const contentIds = new Set(content.map(field => field.id))
    const remaining = candidates.filter(field => !contentIds.has(field.id))
    const mappedOrder = [
      mapping.status_field_id,
      mapping.assignee_field_id,
      mapping.priority_field_id,
      mapping.due_field_id,
      mapping.parent_field_id,
    ].filter((id): id is string => Boolean(id))
    const ranked = [...remaining].sort((left, right) => {
      const leftMapped = mappedOrder.indexOf(left.id)
      const rightMapped = mappedOrder.indexOf(right.id)
      if (leftMapped >= 0 || rightMapped >= 0) {
        return (leftMapped < 0 ? 999 : leftMapped) - (rightMapped < 0 ? 999 : rightMapped)
      }
      const leftEmpty = textValue(record.cells[left.id]) ? 0 : 1
      const rightEmpty = textValue(record.cells[right.id]) ? 0 : 1
      return leftEmpty - rightEmpty
    })
    return {
      content,
      properties: ranked.slice(0, PROPERTY_LIMIT),
      more: ranked.slice(PROPERTY_LIMIT),
    }
  }, [fields, project.provider_config?.board_mapping, record])

  async function updateField(fieldId: string, value: unknown) {
    const updated = await api.updateRecord(project.id, recordId, { [fieldId]: value })
    setRecord(current =>
      current
        ? { ...current, cells: { ...current.cells, [fieldId]: updated.cells[fieldId] ?? value } }
        : current
    )
  }

  if (error) return <p className="mt-5 text-sm text-destructive">{error}</p>
  if (!record) {
    return (
      <div className="mt-5 flex items-center gap-2 text-sm text-text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> 加载记录内容…
      </div>
    )
  }

  return (
    <section className="mt-5" data-testid="aitable-task-fields">
      {layout.content.length > 0 ? (
        <div data-testid="aitable-detail-content-blocks">
          {layout.content.map(field => (
            <ContentBlock
              key={field.id}
              field={field}
              value={record.cells[field.id]}
              canEdit={item.can_edit !== false}
              onSave={value => updateField(field.id, value)}
            />
          ))}
        </div>
      ) : null}

      {layout.properties.length > 0 ? (
        <section
          className="mt-6 border-t border-border pt-4"
          data-testid="aitable-detail-properties"
        >
          <h3 className="mb-1 text-sm font-medium">记录属性</h3>
          <div className="grid gap-x-8 md:grid-cols-2">
            {layout.properties.map(field => (
              <PropertyItem
                key={field.id}
                field={field}
                value={record.cells[field.id]}
                canEdit={item.can_edit !== false}
                onSave={value => updateField(field.id, value)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {layout.more.length > 0 ? (
        <section className="mt-2">
          <button
            type="button"
            data-testid="aitable-detail-more-toggle"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(current => !current)}
            className="flex h-8 items-center gap-1.5 rounded-lg text-sm text-text-muted hover:text-text-primary"
          >
            {moreOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            更多字段 <span className="text-xs">{layout.more.length}</span>
          </button>
          {moreOpen ? (
            <div className="grid gap-x-8 md:grid-cols-2" data-testid="aitable-detail-more-fields">
              {layout.more.map(field => (
                <PropertyItem
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
      ) : null}
    </section>
  )
}
