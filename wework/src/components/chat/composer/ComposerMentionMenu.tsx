import { ClipboardList, File, Folder, Package, Paperclip, Target } from 'lucide-react'
import type { RefObject } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeWorkspaceSearchItem } from '@/types/api'
import type { ComposerMentionCandidate } from './composerMentionCandidates'

export type MentionMenuRow =
  | { kind: 'candidate'; candidate: ComposerMentionCandidate }
  | { kind: 'path'; item: RuntimeWorkspaceSearchItem }
  | { kind: 'files-action' }
  | { kind: 'goal-action' }
  | { kind: 'plan-action' }

interface ComposerMentionMenuProps {
  menuRef: RefObject<HTMLDivElement | null>
  rows: MentionMenuRow[]
  selectedIndex: number
  className: string
  mentionMode: boolean
  loading: boolean
  error: boolean
  canBrowseFiles: boolean
  onRetry: () => void
  onHighlight: (index: number) => void
  onSelect: (index: number) => void
}

export function ComposerMentionMenu({
  menuRef,
  rows,
  selectedIndex,
  className,
  mentionMode,
  loading,
  error,
  canBrowseFiles,
  onRetry,
  onHighlight,
  onSelect,
}: ComposerMentionMenuProps) {
  const { t } = useTranslation('common')

  return (
    <div
      ref={menuRef}
      data-testid="local-skill-autocomplete"
      role="listbox"
      className={[
        'absolute bottom-[calc(100%+0.5rem)] z-popover max-h-64 overflow-y-auto rounded-xl border border-border bg-background px-1.5 py-1.5 text-text-primary shadow-[0_12px_34px_rgba(0,0,0,0.12)]',
        className,
      ].join(' ')}
    >
      <div className="px-2 pb-1 pt-0.5 text-xs font-normal leading-4 text-text-muted">
        {mentionMode ? t('workbench.mention_add', '添加') : t('workbench.local_skills', '技能')}
      </div>
      {rows.length === 0 && loading ? (
        <div className="px-2.5 py-2 text-sm leading-[18px] text-text-muted">
          {t('workbench.mention_loading', '正在搜索...')}
        </div>
      ) : rows.length === 0 && error ? (
        <button
          type="button"
          data-testid="local-skill-load-error"
          className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm leading-5 text-text-muted hover:bg-muted"
          onClick={onRetry}
        >
          <Package className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
          <span className="min-w-0 flex-1 truncate">
            {t('workbench.mention_search_error', '搜索失败')}
          </span>
          <span
            data-testid="local-skill-retry-label"
            className="shrink-0 text-xs font-medium leading-5 text-text-secondary"
          >
            {t('workbench.retry_local_skills')}
          </span>
        </button>
      ) : rows.length === 0 ? (
        <div className="px-2.5 py-2 text-sm leading-[18px] text-text-muted">
          {t('workbench.mention_no_results', '没有匹配结果')}
        </div>
      ) : (
        rows.map((row, index) => {
          const candidate = row.kind === 'candidate' ? row.candidate : null
          const pathItem = row.kind === 'path' ? row.item : null
          const enabled = candidate
            ? candidate.enabled
            : row.kind !== 'files-action' || canBrowseFiles
          const Icon = pathItem
            ? pathItem.matchType === 'directory'
              ? Folder
              : File
            : row.kind === 'files-action'
              ? Paperclip
              : row.kind === 'goal-action'
                ? Target
                : row.kind === 'plan-action'
                  ? ClipboardList
                  : Package
          const title = candidate
            ? candidate.title
            : pathItem
              ? pathItem.fileName
              : row.kind === 'files-action'
                ? t('workbench.mention_files_and_folders', '文件和文件夹')
                : row.kind === 'goal-action'
                  ? t('workbench.goal_chip', '目标')
                  : t('workbench.plan_mode', '计划模式')
          const description =
            candidate?.description ?? (pathItem ? parentComposerPath(pathItem.path) : undefined)
          return (
            <button
              key={candidate?.key ?? `${row.kind}:${pathItem?.path ?? ''}`}
              type="button"
              data-testid={
                candidate
                  ? `${candidate.kind === 'app' ? 'local-app' : 'local-skill'}-option-${candidate.testId}`
                  : pathItem
                    ? `workspace-mention-option-${index}`
                    : `mention-${row.kind}`
              }
              aria-selected={index === selectedIndex}
              role="option"
              disabled={!enabled}
              aria-disabled={!enabled}
              onMouseEnter={() => enabled && onHighlight(index)}
              onPointerEnter={() => enabled && onHighlight(index)}
              onClick={() => enabled && onSelect(index)}
              className={[
                'flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent',
                index === selectedIndex ? 'bg-muted' : '',
              ].join(' ')}
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="shrink-0 truncate text-sm font-medium leading-5 text-text-primary">
                  {title}
                </span>
                {description && (
                  <span className="min-w-0 truncate text-sm font-normal leading-5 text-text-muted">
                    {description}
                  </span>
                )}
              </span>
              {candidate && (
                <span
                  data-testid={`local-skill-source-${candidate.testId}`}
                  className="shrink-0 text-xs leading-5 text-text-muted"
                >
                  {candidate.metaLabel}
                </span>
              )}
            </button>
          )
        })
      )}
    </div>
  )
}

function parentComposerPath(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const separator = normalized.lastIndexOf('/')
  return separator > 0 ? normalized.slice(0, separator) : ''
}
