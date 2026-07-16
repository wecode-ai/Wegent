import { ArrowDown, ArrowUp, GripVertical, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  getAppPreferences,
  updateAppPreferences,
  type QuickPhrase,
  type QuickPhraseMode,
} from '@/tauri/appPreferences'
import { SettingsPage, SettingsPageHeader } from './settings-ui'

const emptyPhrase = (): QuickPhrase => ({
  id: crypto.randomUUID(),
  title: '',
  content: '',
  mode: 'normal',
})

export function QuickPhrasesSettingsPage() {
  const { t } = useTranslation('common')
  const [phrases, setPhrases] = useState<QuickPhrase[]>([])
  const [editing, setEditing] = useState<QuickPhrase | null>(null)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void getAppPreferences().then(value => setPhrases(value.quickPhrases))
  }, [])

  const save = async (next: QuickPhrase[]) => {
    setPhrases(next)
    try {
      await updateAppPreferences({ quickPhrases: next })
      setError('')
    } catch {
      setError(t('workbench.quick_phrases_save_error', '无法保存快捷短语，请重试'))
    }
  }
  const move = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= phrases.length) return
    const next = [...phrases]
    ;[next[index], next[target]] = [next[target], next[index]]
    void save(next)
  }
  const commitEditing = () => {
    if (!editing?.title.trim() || !editing.content.trim()) {
      setError(t('workbench.quick_phrase_required', '标题和内容不能为空'))
      return
    }
    const normalized = { ...editing, title: editing.title.trim(), content: editing.content.trim() }
    const exists = phrases.some(item => item.id === editing.id)
    void save(
      exists
        ? phrases.map(item => (item.id === editing.id ? normalized : item))
        : [...phrases, normalized]
    )
    setEditing(null)
  }

  return (
    <SettingsPage data-testid="quick-phrases-settings-page">
      <SettingsPageHeader
        title={t('workbench.quick_phrases', '快捷短语')}
        description={t('workbench.quick_phrases_description', '创建和排序输入框中常用的短语。')}
        actions={
          <button
            type="button"
            data-testid="add-quick-phrase-button"
            onClick={() => setEditing(emptyPhrase())}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3 text-sm text-background"
          >
            <Plus className="h-4 w-4" />
            {t('workbench.quick_phrase_add', '新建短语')}
          </button>
        }
      />
      {error && (
        <div
          role="alert"
          className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}
      <div className="space-y-1">
        {phrases.map((phrase, index) => (
          <div
            key={phrase.id}
            draggable
            onDragStart={() => setDraggedId(phrase.id)}
            onDragOver={event => event.preventDefault()}
            onDrop={() => {
              const from = phrases.findIndex(item => item.id === draggedId)
              if (from < 0 || from === index) return
              const next = [...phrases]
              const [item] = next.splice(from, 1)
              next.splice(index, 0, item)
              setDraggedId(null)
              void save(next)
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
                  : 'Goal'}
            </span>
            <button
              type="button"
              data-testid={`quick-phrase-move-up-${phrase.id}`}
              onClick={() => move(index, -1)}
              disabled={index === 0}
              className="h-8 w-8 rounded-lg p-2 hover:bg-background disabled:opacity-30"
              aria-label={t('workbench.move_up', '上移')}
            >
              <ArrowUp className="h-4 w-4" />
            </button>
            <button
              type="button"
              data-testid={`quick-phrase-move-down-${phrase.id}`}
              onClick={() => move(index, 1)}
              disabled={index === phrases.length - 1}
              className="h-8 w-8 rounded-lg p-2 hover:bg-background disabled:opacity-30"
              aria-label={t('workbench.move_down', '下移')}
            >
              <ArrowDown className="h-4 w-4" />
            </button>
            <button
              type="button"
              data-testid={`quick-phrase-edit-${phrase.id}`}
              onClick={() => setEditing(phrase)}
              className="h-8 w-8 rounded-lg p-2 hover:bg-background"
              aria-label={t('workbench.edit', '编辑')}
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              type="button"
              data-testid={`quick-phrase-delete-${phrase.id}`}
              onClick={() => {
                if (
                  window.confirm(t('workbench.quick_phrase_delete_confirm', '删除这条快捷短语？'))
                ) {
                  void save(phrases.filter(item => item.id !== phrase.id))
                }
              }}
              className="h-8 w-8 rounded-lg p-2 text-destructive hover:bg-destructive/10"
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
                data-testid="quick-phrase-title-input"
                value={editing.title}
                onChange={event => setEditing({ ...editing, title: event.target.value })}
                className="mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 outline-none focus:border-blue-500"
              />
            </label>
            <label className="mt-3 block text-sm">
              {t('workbench.quick_phrase_content', '内容')}
              <textarea
                data-testid="quick-phrase-content-input"
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
                      data-testid={`quick-phrase-mode-${mode}`}
                      checked={editing.mode === mode}
                      onChange={() => setEditing({ ...editing, mode })}
                    />
                    {mode === 'normal'
                      ? t('workbench.quick_phrase_mode_normal', '普通')
                      : mode === 'plan'
                        ? t('workbench.quick_phrase_mode_plan', '计划模式')
                        : 'Goal'}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                data-testid="quick-phrase-cancel-button"
                onClick={() => setEditing(null)}
                className="h-8 rounded-lg px-3 text-sm hover:bg-muted"
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                type="button"
                data-testid="quick-phrase-save-button"
                onClick={commitEditing}
                className="h-8 rounded-lg bg-foreground px-3 text-sm text-background"
              >
                {t('common.save', '保存')}
              </button>
            </div>
          </div>
        </div>
      )}
    </SettingsPage>
  )
}
