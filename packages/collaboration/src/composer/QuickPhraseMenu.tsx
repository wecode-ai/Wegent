import type { QuickPhrase } from '@wegent/chat-core/composer-quick-phrases'
import { File, FileText, MessageSquareText, Settings } from 'lucide-react'
import { useState } from 'react'
import { composerIconActionDensity } from '../controls/recipes'
import { SearchableSelect } from '../controls/SearchableSelect'
import type { CollaborationTranslate } from '../i18n'
import { Button as ControlButton } from '../markdown/Button'

export interface QuickPhraseMenuProps {
  translate: CollaborationTranslate
  globalPhrases: QuickPhrase[]
  attachmentUrl?: (path: string) => string | undefined
  onRemoveStash?: (phrase: QuickPhrase) => Promise<void>
  onClearStash?: () => Promise<void>
  onManage?: () => void
  disabled?: boolean
  compact?: boolean
  projectPhrases?: QuickPhrase[]
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

function StashThumbnail({
  path,
  attachmentUrl,
}: {
  path: string
  attachmentUrl?: QuickPhraseMenuProps['attachmentUrl']
}) {
  if (isImagePath(path) && attachmentUrl) {
    return (
      <img
        src={attachmentUrl!(path)}
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

function StashPreview({
  phrase,
  attachmentUrl,
}: {
  phrase: QuickPhrase
  attachmentUrl?: QuickPhraseMenuProps['attachmentUrl']
}) {
  const paths = phrase.attachmentPaths ?? []
  const imagePath = paths.find(isImagePath)
  return (
    <div
      data-testid="quick-phrase-stash-preview"
      className="w-full rounded-xl border border-border bg-background p-2 shadow-lg"
    >
      {imagePath && attachmentUrl ? (
        <img
          src={attachmentUrl!(imagePath)}
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

export function QuickPhraseMenu({
  translate: t,
  globalPhrases,
  attachmentUrl,
  onRemoveStash,
  onClearStash,
  onManage,
  disabled,
  compact,
  projectPhrases = [],
  onSelect,
}: QuickPhraseMenuProps) {
  const [open, setOpen] = useState(false)
  const [previewedStash, setPreviewedStash] = useState<QuickPhrase | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionPending, setActionPending] = useState(false)
  const visibleGlobalPhrases = open ? globalPhrases : []
  const visibleProjectPhrases = open ? projectPhrases : []
  const stashed = visibleGlobalPhrases.filter(phrase => phrase.id.startsWith('stash-'))
  const entries = [
    ...stashed.map(phrase => ({
      phrase,
      value: `global:${phrase.id}`,
      group: t('workbench.quick_phrases_stash', '暂存区'),
    })),
    ...visibleProjectPhrases
      .filter(phrase => !phrase.id.startsWith('stash-'))
      .map(phrase => ({
        phrase,
        value: `project:${phrase.id}`,
        group: t('workbench.project_quick_phrases_title', '项目快捷短语'),
      })),
    ...visibleGlobalPhrases
      .filter(phrase => !phrase.id.startsWith('stash-'))
      .map(phrase => ({
        phrase,
        value: `global:${phrase.id}`,
        group: t('workbench.global_quick_phrases_title', '全局快捷短语'),
      })),
  ]
  const runStashAction = async (action: (() => Promise<void>) | undefined) => {
    if (!action || actionPending) return
    setActionPending(true)
    setActionError(null)
    try {
      await action()
      setPreviewedStash(null)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setActionPending(false)
    }
  }
  return (
    <SearchableSelect
      density="dense"
      appearance="plain"
      contentClassName="w-80"
      value=""
      disabled={disabled}
      open={open}
      onOpenChange={next => {
        setOpen(next)
        if (!next) setPreviewedStash(null)
      }}
      autoHighlight="always"
      testId="quick-phrase-button"
      menuTestId="quick-phrase-menu"
      searchTestId="quick-phrase-search-input"
      accessibleLabel={t('workbench.quick_phrases', '快捷短语')}
      searchPlaceholder={t('workbench.quick_phrases_search', '搜索快捷短语…')}
      emptyLabel={t('workbench.quick_phrases_empty', '没有匹配的快捷短语')}
      className={
        compact
          ? composerIconActionDensity + ' justify-center rounded-full'
          : composerIconActionDensity + ' justify-center'
      }
      triggerContent={<MessageSquareText className="h-4 w-4" aria-hidden="true" />}
      options={entries.map(({ phrase, value, group }) => ({
        value,
        label: phrase.title,
        description:
          phrase.content ||
          t('workbench.quick_phrase_attachment_count', '{{count}} 个附件', {
            count: phrase.attachmentPaths?.length ?? 0,
          }),
        group,
        testId: phrase.id.startsWith('stash-')
          ? `quick-phrase-stash-${phrase.id}`
          : value.startsWith('project:')
            ? `project-quick-phrase-option-${phrase.id}`
            : `quick-phrase-option-${phrase.id}`,
        icon: phrase.id.startsWith('stash-') ? (
          <span data-testid={`quick-phrase-stash-select-${phrase.id}`}>
            {phrase.attachmentPaths?.[0] ? (
              <StashThumbnail path={phrase.attachmentPaths[0]} attachmentUrl={attachmentUrl} />
            ) : (
              <MessageSquareText className="h-4 w-4" aria-hidden="true" />
            )}
          </span>
        ) : undefined,
      }))}
      onHighlight={option => {
        const phrase = entries.find(entry => entry.value === option?.value)?.phrase
        setPreviewedStash(phrase?.id.startsWith('stash-') ? phrase : null)
      }}
      onChange={value => {
        const phrase = entries.find(entry => entry.value === value)?.phrase
        if (phrase) onSelect(phrase)
        setOpen(false)
      }}
      searchStatus={
        actionError ? (
          <p role="alert" className="p-2 text-sm text-destructive">
            {actionError}
          </p>
        ) : undefined
      }
      header={
        stashed.length ? (
          <div className="flex items-center justify-between px-2 pb-2">
            <span className="text-xs text-text-secondary">
              {t('workbench.quick_phrases_stash', '暂存区')}
            </span>
            <ControlButton
              variant="unstyled"
              data-testid="quick-phrase-stash-clear-button"
              disabled={actionPending || !onClearStash}
              onClick={() => void runStashAction(onClearStash)}
            >
              {t('workbench.quick_phrase_stash_clear', '清空')}
            </ControlButton>
          </div>
        ) : undefined
      }
      preview={
        previewedStash ? (
          <div className="border-t border-border pt-2">
            <StashPreview phrase={previewedStash} attachmentUrl={attachmentUrl} />
            <ControlButton
              variant="ghost"
              data-testid={`quick-phrase-stash-delete-${previewedStash.id}`}
              disabled={actionPending || !onRemoveStash}
              onClick={() =>
                void runStashAction(onRemoveStash ? () => onRemoveStash(previewedStash) : undefined)
              }
            >
              {t('workbench.quick_phrase_stash_delete', '删除暂存项')}
            </ControlButton>
          </div>
        ) : undefined
      }
      actions={
        onManage
          ? [
              {
                testId: 'manage-quick-phrases-button',
                label: t('workbench.quick_phrases_manage', '管理快捷短语…'),
                icon: <Settings aria-hidden="true" className="h-4 w-4" />,
                onSelect: onManage,
              },
            ]
          : []
      }
    />
  )
}
