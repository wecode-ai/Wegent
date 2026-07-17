import { MessageSquareText, Search, Settings } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import type { QuickPhrase } from '@/tauri/appPreferences'
import { useQuickPhrases } from '@/hooks/useQuickPhrases'

interface QuickPhraseMenuProps {
  disabled?: boolean
  compact?: boolean
  onSelect: (phrase: QuickPhrase) => void
}

export function QuickPhraseMenu({ disabled, compact, onSelect }: QuickPhraseMenuProps) {
  const { t } = useTranslation('common')
  const phrases = useQuickPhrases()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return phrases
    return phrases.filter(item =>
      `${item.title}\n${item.content}`.toLocaleLowerCase().includes(normalized)
    )
  }, [phrases, query])

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    rootRef.current
      ?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' })
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open, selectedIndex])

  const choose = (phrase: QuickPhrase) => {
    onSelect(phrase)
    setOpen(false)
    setQuery('')
    setSelectedIndex(0)
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        data-testid="quick-phrase-button"
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
        className={
          compact
            ? 'flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-muted disabled:opacity-40'
            : 'flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm text-text-secondary hover:bg-muted disabled:opacity-40'
        }
        aria-label={t('workbench.quick_phrases', '快捷短语')}
        aria-expanded={open}
      >
        <MessageSquareText className="h-4 w-4" />
        {!compact && <span>{t('workbench.quick_phrases', '快捷短语')}</span>}
      </button>
      {open && (
        <div
          data-testid="quick-phrase-menu"
          className="absolute bottom-[calc(100%+0.5rem)] left-0 z-popover w-[min(26rem,calc(100vw-2rem))] rounded-xl border border-border bg-background p-1.5 text-text-primary shadow-lg"
        >
          <div className="flex h-9 items-center gap-2 rounded-lg bg-muted/60 px-2">
            <Search className="h-4 w-4 text-text-muted" />
            <input
              ref={inputRef}
              data-testid="quick-phrase-search-input"
              value={query}
              onChange={event => {
                setQuery(event.target.value)
                setSelectedIndex(0)
              }}
              onKeyDown={event => {
                if (event.key === 'Escape') setOpen(false)
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setSelectedIndex(index => Math.min(index + 1, filtered.length - 1))
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setSelectedIndex(index => Math.max(index - 1, 0))
                }
                if (event.key === 'Enter' && filtered[selectedIndex]) {
                  event.preventDefault()
                  choose(filtered[selectedIndex])
                }
              }}
              placeholder={t('workbench.quick_phrases_search', '搜索快捷短语…')}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-muted"
            />
          </div>
          <div role="listbox" className="mt-1 max-h-64 overflow-y-auto">
            {filtered.map((phrase, index) => (
              <button
                key={phrase.id}
                type="button"
                role="option"
                aria-selected={selectedIndex === index}
                data-testid={`quick-phrase-option-${phrase.id}`}
                onPointerEnter={() => setSelectedIndex(index)}
                onClick={() => choose(phrase)}
                className={`flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left ${selectedIndex === index ? 'bg-muted' : 'hover:bg-muted'}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{phrase.title}</span>
                  <span className="block truncate text-xs text-text-muted">{phrase.content}</span>
                </span>
                <span className="text-xs text-text-muted">
                  {phrase.mode === 'normal'
                    ? t('workbench.quick_phrase_mode_normal', '普通')
                    : phrase.mode === 'plan'
                      ? t('workbench.quick_phrase_mode_plan', '计划')
                      : t('workbench.quick_phrase_mode_goal', '目标模式')}
                </span>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-2 py-3 text-sm text-text-muted">
                {t('workbench.quick_phrases_empty', '没有匹配的快捷短语')}
              </div>
            )}
          </div>
          <button
            type="button"
            data-testid="manage-quick-phrases-button"
            onClick={() => {
              setOpen(false)
              navigateTo('/settings/personal/quick-phrases')
            }}
            className="mt-1 flex h-8 w-full items-center gap-2 border-t border-border px-2 pt-1 text-sm text-text-secondary hover:text-text-primary"
          >
            <Settings className="h-4 w-4" />
            {t('workbench.quick_phrases_manage', '管理快捷短语…')}
          </button>
        </div>
      )}
    </div>
  )
}
