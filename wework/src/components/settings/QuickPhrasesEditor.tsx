import { ArrowDown, ArrowUp, GripVertical, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { QuickPhrase, QuickPhraseMode } from '@/desktop/appPreferences'

export type QuickPhraseChangeAction = 'create' | 'update' | 'delete' | 'move'

interface QuickPhrasesEditorProps {
  phrases: QuickPhrase[]
  onChange: (phrases: QuickPhrase[], action: QuickPhraseChangeAction) => void
  disabled?: boolean
  testIdPrefix?: string
}

const emptyPhrase = (): QuickPhrase => ({
  id: crypto.randomUUID(),
  title: '',
  content: '',
  mode: 'normal',
})

export function QuickPhrasesEditor({
  phrases,
  onChange,
  disabled = false,
  testIdPrefix = '',
}: QuickPhrasesEditorProps) {
  const { t } = useTranslation('common')
  const [editing, setEditing] = useState<QuickPhrase | null>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [validationError, setValidationError] = useState('')
  const testId = (value: string) => `${testIdPrefix}${value}`

  const move = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= phrases.length) return
    const next = [...phrases]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next, 'move')
  }

  const commitEditing = () => {
    if (!editing?.title.trim() || !editing.content.trim()) {
      setValidationError(t('workbench.quick_phrase_required', '标题和内容不能为空'))
      return
    }
    const normalized = { ...editing, title: editing.title.trim(), content: editing.content.trim() }
    const exists = phrases.some(item => item.id === editing.id)
    onChange(
      exists
        ? phrases.map(item => (item.id === editing.id ? normalized : item))
        : [...phrases, normalized],
      exists ? 'update' : 'create'
    )
    setValidationError('')
    setEditing(null)
  }

  return (
    <>
      {validationError && (
        <div
          role="alert"
          className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {validationError}
        </div>
      )}
      <button
        type="button"
        data-testid={testId('add-quick-phrase-button')}
        disabled={disabled}
        onClick={() => {
          setValidationError('')
          setEditing(emptyPhrase())
        }}
        className="mb-4 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 py-3 text-sm font-medium text-text-primary hover:border-blue-500 hover:bg-blue-500/5 disabled:opacity-50"
      >
        <Plus className="h-4 w-4" />
        {t('workbench.quick_phrase_add', '新增快捷短语')}
      </button>
      <div className="space-y-1">
        {phrases.map((phrase, index) => (
          <div
            key={phrase.id}
            draggable={!disabled}
            onDragStart={() => setDraggedId(phrase.id)}
            onDragOver={event => event.preventDefault()}
            onDrop={() => {
              const from = phrases.findIndex(item => item.id === draggedId)
              if (from < 0 || from === index) return
              const next = [...phrases]
              const [item] = next.splice(from, 1)
              next.splice(index, 0, item)
              setDraggedId(null)
              onChange(next, 'move')
            }}
            className="flex min-h-14 items-center gap-2 rounded-xl px-2 py-2 hover:bg-muted"
          >
            <GripVertical className="h-4 w-4 cursor-grab text-text-muted" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{phrase.title}</div>
              <div className="truncate text-xs text-text-muted">{phrase.content}</div>
            </div>
            <span className="text-xs text-text-muted">
              {phrase.mode === 'normal'
                ? t('workbench.quick_phrase_mode_normal', '普通')
                : phrase.mode === 'plan'
                  ? t('workbench.quick_phrase_mode_plan', '计划')
                  : t('workbench.quick_phrase_mode_goal', '目标模式')}
            </span>
            <button
              type="button"
              data-testid={testId(`quick-phrase-move-up-${phrase.id}`)}
              onClick={() => move(index, -1)}
              disabled={disabled || index === 0}
              className="h-8 w-8 rounded-lg p-2 hover:bg-background disabled:opacity-30"
              aria-label={t('workbench.move_up', '上移')}
            >
              <ArrowUp className="h-4 w-4" />
            </button>
            <button
              type="button"
              data-testid={testId(`quick-phrase-move-down-${phrase.id}`)}
              onClick={() => move(index, 1)}
              disabled={disabled || index === phrases.length - 1}
              className="h-8 w-8 rounded-lg p-2 hover:bg-background disabled:opacity-30"
              aria-label={t('workbench.move_down', '下移')}
            >
              <ArrowDown className="h-4 w-4" />
            </button>
            <button
              type="button"
              data-testid={testId(`quick-phrase-edit-${phrase.id}`)}
              onClick={() => {
                setValidationError('')
                setEditing(phrase)
              }}
              disabled={disabled}
              className="h-8 w-8 rounded-lg p-2 hover:bg-background disabled:opacity-30"
              aria-label={t('workbench.edit', '编辑')}
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              type="button"
              data-testid={testId(`quick-phrase-delete-${phrase.id}`)}
              onClick={() => {
                if (
                  window.confirm(t('workbench.quick_phrase_delete_confirm', '删除这条快捷短语？'))
                ) {
                  onChange(
                    phrases.filter(item => item.id !== phrase.id),
                    'delete'
                  )
                }
              }}
              disabled={disabled}
              className="h-8 w-8 rounded-lg p-2 text-destructive hover:bg-destructive/10 disabled:opacity-30"
              aria-label={t('workbench.delete', '删除')}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      {editing && (
        <div
          className="fixed inset-0 z-modal flex items-center justify-center bg-black/15 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-[520px] rounded-[20px] border border-border bg-background p-5 shadow-lg">
            <h2 className="heading-sm">{t('workbench.quick_phrase_edit', '编辑快捷短语')}</h2>
            <label className="mt-4 block text-sm">
              {t('workbench.quick_phrase_title', '标题')}
              <input
                autoFocus
                data-testid={testId('quick-phrase-title-input')}
                value={editing.title}
                onChange={event => setEditing({ ...editing, title: event.target.value })}
                className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 outline-none focus:border-blue-500"
              />
            </label>
            <label className="mt-3 block text-sm">
              {t('workbench.quick_phrase_content', '内容')}
              <textarea
                data-testid={testId('quick-phrase-content-input')}
                value={editing.content}
                onChange={event => setEditing({ ...editing, content: event.target.value })}
                rows={5}
                className="mt-1 w-full resize-y rounded-lg border border-border bg-background p-3 outline-none focus:border-blue-500"
              />
            </label>
            <fieldset className="mt-3">
              <legend className="text-sm">{t('workbench.quick_phrase_mode', '使用模式')}</legend>
              <div className="mt-2 flex gap-4">
                {(['normal', 'plan', 'goal'] as QuickPhraseMode[]).map(mode => (
                  <label key={mode} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="radio"
                      data-testid={testId(`quick-phrase-mode-${mode}`)}
                      checked={editing.mode === mode}
                      onChange={() => setEditing({ ...editing, mode })}
                    />
                    {mode === 'normal'
                      ? t('workbench.quick_phrase_mode_normal', '普通')
                      : mode === 'plan'
                        ? t('workbench.quick_phrase_mode_plan', '计划模式')
                        : t('workbench.quick_phrase_mode_goal', '目标模式')}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                data-testid={testId('quick-phrase-cancel-button')}
                onClick={() => {
                  setValidationError('')
                  setEditing(null)
                }}
                className="h-8 rounded-lg px-3 text-sm hover:bg-muted"
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                type="button"
                data-testid={testId('quick-phrase-save-button')}
                onClick={commitEditing}
                className="h-8 rounded-lg bg-text-primary px-3 text-sm font-medium text-background hover:opacity-90"
              >
                {t('common.save', '保存')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
