import { File, FileText, MessageSquareText, Search, Settings, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { getAppPreferences, updateAppPreferences, type QuickPhrase } from '@/tauri/appPreferences'
import { useQuickPhrases } from '@/hooks/useQuickPhrases'

interface QuickPhraseMenuProps {
  disabled?: boolean
  compact?: boolean
  onSelect: (phrase: QuickPhrase) => void
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'])

function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path
}

function isImagePath(path: string) {
  const extension = path.split('.').pop()?.toLocaleLowerCase() ?? ''
  return IMAGE_EXTENSIONS.has(extension)
}

function StashThumbnail({ path }: { path: string }) {
  if (isImagePath(path)) {
    return (
      <img
        src={convertFileSrc(path)}
        alt=""
        className="h-10 w-10 rounded-lg border border-border bg-muted object-cover"
      />
    )
  }
  return (
    <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-muted text-text-muted">
      <File className="h-5 w-5" />
    </span>
  )
}

function StashCard({
  phrase,
  selected,
  deleteLabel,
  onHover,
  onSelect,
  onDelete,
}: {
  phrase: QuickPhrase
  selected: boolean
  deleteLabel: string
  onHover: (phrase: QuickPhrase | null) => void
  onSelect: () => void
  onDelete: () => void
}) {
  const paths = phrase.attachmentPaths ?? []
  const thumbnails = paths.slice(0, 3)
  return (
    <div
      role="option"
      aria-selected={selected}
      data-testid={`quick-phrase-stash-${phrase.id}`}
      onPointerEnter={() => onHover(phrase)}
      onPointerLeave={() => onHover(null)}
      className={`relative h-16 min-w-24 max-w-32 shrink-0 rounded-xl border ${selected ? 'border-foreground/15 bg-muted' : 'border-border hover:bg-muted'}`}
    >
      <button
        type="button"
        onFocus={() => onHover(phrase)}
        onBlur={() => onHover(null)}
        onClick={onSelect}
        className="flex h-full w-full items-center justify-center px-2 text-left"
      >
        {paths.length > 0 ? (
          <span className="relative flex h-11 min-w-12 items-center justify-center">
            {thumbnails.map((path, index) => (
              <span
                key={`${path}-${index}`}
                className="absolute"
                style={{ transform: `translateX(${(index - (thumbnails.length - 1) / 2) * 12}px)` }}
              >
                <StashThumbnail path={path} />
              </span>
            ))}
            {paths.length > 3 && (
              <span className="absolute -bottom-1 -right-1 rounded-full bg-foreground px-1.5 py-0.5 text-xs text-background">
                +{paths.length - 3}
              </span>
            )}
          </span>
        ) : (
          <span className="flex min-w-0 flex-col items-center gap-1">
            <MessageSquareText className="h-5 w-5 text-text-muted" />
            <span className="max-w-24 truncate text-xs">{phrase.title}</span>
          </span>
        )}
      </button>
      <button
        type="button"
        data-testid={`quick-phrase-stash-delete-${phrase.id}`}
        aria-label={deleteLabel}
        title={deleteLabel}
        onClick={event => {
          event.stopPropagation()
          onDelete()
        }}
        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background/90 text-text-muted shadow-sm hover:bg-muted hover:text-text-primary"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function StashPreview({ phrase }: { phrase: QuickPhrase }) {
  const paths = phrase.attachmentPaths ?? []
  const imagePath = paths.find(isImagePath)
  return (
    <div
      data-testid="quick-phrase-stash-preview"
      className="absolute bottom-[calc(100%+0.5rem)] left-1 z-popover w-64 rounded-xl border border-border bg-background p-2 shadow-lg"
    >
      {imagePath ? (
        <img
          src={convertFileSrc(imagePath)}
          alt={fileName(imagePath)}
          className="max-h-48 w-full rounded-lg bg-muted object-contain"
        />
      ) : phrase.content ? (
        <div className="max-h-40 overflow-y-auto whitespace-pre-wrap text-sm">{phrase.content}</div>
      ) : (
        <FileText className="h-8 w-8 text-text-muted" />
      )}
      <div className="mt-2 truncate text-sm font-medium">{phrase.title}</div>
      {paths.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {paths.slice(0, 4).map(path => (
            <div key={path} className="truncate text-xs text-text-muted">
              {fileName(path)}
            </div>
          ))}
          {paths.length > 4 && <div className="text-xs text-text-muted">+{paths.length - 4}</div>}
        </div>
      )}
    </div>
  )
}

export function QuickPhraseMenu({ disabled, compact, onSelect }: QuickPhraseMenuProps) {
  const { t } = useTranslation('common')
  const phrases = useQuickPhrases()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [previewedStash, setPreviewedStash] = useState<QuickPhrase | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return phrases
    return phrases.filter(item =>
      `${item.title}\n${item.content}`.toLocaleLowerCase().includes(normalized)
    )
  }, [phrases, query])
  const stashed = filtered.filter(item => item.id.startsWith('stash-'))
  const regular = filtered.filter(item => !item.id.startsWith('stash-'))
  const visiblePhrases = [...stashed, ...regular]

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

  const removeStash = async (phrase: QuickPhrase) => {
    try {
      const preferences = await getAppPreferences()
      await updateAppPreferences({
        quickPhrases: preferences.quickPhrases.filter(item => item.id !== phrase.id),
      })
      setPreviewedStash(current => (current?.id === phrase.id ? null : current))
    } catch (error) {
      console.error('[quick-phrases] failed to delete stash', error)
    }
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
                  setSelectedIndex(index => Math.min(index + 1, visiblePhrases.length - 1))
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setSelectedIndex(index => Math.max(index - 1, 0))
                }
                if (event.key === 'Enter' && visiblePhrases[selectedIndex]) {
                  event.preventDefault()
                  choose(visiblePhrases[selectedIndex])
                }
              }}
              placeholder={t('workbench.quick_phrases_search', '搜索快捷短语…')}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-muted"
            />
          </div>
          {stashed.length > 0 && (
            <div className="relative mt-1 px-1 pt-2">
              {previewedStash && <StashPreview phrase={previewedStash} />}
              <div className="mb-1.5 px-1 text-xs font-medium text-text-muted">
                {t('workbench.quick_phrases_stash', '暂存区')}
              </div>
              <div
                data-testid="quick-phrase-stash-tray"
                role="listbox"
                className="flex gap-2 overflow-x-auto pb-2"
              >
                {stashed.map((phrase, index) => (
                  <StashCard
                    key={phrase.id}
                    phrase={phrase}
                    selected={selectedIndex === index}
                    deleteLabel={t('workbench.quick_phrase_stash_delete', '删除暂存项')}
                    onHover={setPreviewedStash}
                    onSelect={() => choose(phrase)}
                    onDelete={() => void removeStash(phrase)}
                  />
                ))}
              </div>
            </div>
          )}
          {stashed.length > 0 && regular.length > 0 && (
            <div className="border-t border-border px-2 pb-1 pt-2 text-xs font-medium text-text-muted">
              {t('workbench.quick_phrases', '快捷短语')}
            </div>
          )}
          <div role="listbox" className="max-h-64 overflow-y-auto">
            {regular.map((phrase, index) => (
              <button
                key={phrase.id}
                type="button"
                role="option"
                aria-selected={selectedIndex === stashed.length + index}
                data-testid={`quick-phrase-option-${phrase.id}`}
                onPointerEnter={() => setSelectedIndex(stashed.length + index)}
                onClick={() => choose(phrase)}
                className={`flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left ${selectedIndex === stashed.length + index ? 'bg-muted' : 'hover:bg-muted'}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{phrase.title}</span>
                  <span className="block truncate text-xs text-text-muted">
                    {phrase.content ||
                      t('workbench.quick_phrase_attachment_count', '{{count}} 个附件', {
                        count: phrase.attachmentPaths?.length ?? 0,
                      })}
                  </span>
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
            {visiblePhrases.length === 0 && (
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
