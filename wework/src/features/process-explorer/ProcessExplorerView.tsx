import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'
import { Check, ChevronDown, ChevronRight, Copy, Pin, RefreshCw } from 'lucide-react'
import type {
  ProcessExplorerClient,
  ProcessOwnerRef,
  ProcessRecord,
  ProcessSnapshot,
} from '@wegent/process-explorer'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { DEFAULT_COLUMN_WIDTHS, resizeColumnWidths } from './columnWidths'
import { describeDegradation } from './errors'
import {
  formatAge,
  formatCpu,
  formatMemory,
  normalizeLaunchDetail,
  splitLaunchDetail,
} from './format'
import { groupProcesses } from './groupProcesses'
import {
  buildProcessTree,
  filterProcessTree,
  flattenProcessTree,
  type ProcessTreeNode,
} from './processTree'

export interface ProcessExplorerViewProps {
  client: ProcessExplorerClient
  alwaysOnTop: boolean
  onToggleAlwaysOnTop: () => void
  onCopyText: (text: string) => Promise<void>
  refreshIntervalMs?: number
}

const DEFAULT_REFRESH_INTERVAL_MS = 2000

const COLUMN_LABELS = [
  { label: 'process_explorer.column_process', align: 'text-left', padding: 'pl-3 pr-3' },
  { label: 'process_explorer.column_pid', align: 'text-right', padding: 'pl-2 pr-3' },
  { label: 'process_explorer.column_cpu', align: 'text-right', padding: 'pl-2 pr-3' },
  { label: 'process_explorer.column_memory', align: 'text-right', padding: 'pl-2 pr-3' },
  { label: 'process_explorer.column_uptime', align: 'text-right', padding: 'pl-2 pr-3' },
] as const

interface RenderGroup {
  owner: ProcessOwnerRef
  tree: ProcessTreeNode[]
  count: number
  cpuPercent: number
  memoryBytes: number
}

/**
 * WeWork's read-only process explorer. It is a developer/support tool: the
 * host owns collection, while this surface groups processes by the WeWork
 * object that owns them.
 */
export function ProcessExplorerView({
  client,
  alwaysOnTop,
  onToggleAlwaysOnTop,
  onCopyText,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
}: ProcessExplorerViewProps) {
  const { t } = useTranslation('common')
  const [snapshot, setSnapshot] = useState<ProcessSnapshot | null>(null)
  const [error, setError] = useState<unknown | null>(null)
  const [filter, setFilter] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [collapsedOwners, setCollapsedOwners] = useState<Set<string>>(() => new Set())
  const [columnWidths, setColumnWidths] = useState<number[]>(() => [...DEFAULT_COLUMN_WIDTHS])
  const loadSequence = useRef(0)
  const tableRef = useRef<HTMLTableElement>(null)
  const resizeCleanupRef = useRef<(() => void) | null>(null)

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    try {
      const next = await client.snapshot()
      if (loadSequence.current !== sequence) return
      setSnapshot(next)
      setError(null)
    } catch (loadError) {
      if (loadSequence.current !== sequence) return
      setError(loadError)
    }
  }, [client])

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0)
    const timer = window.setInterval(() => void load(), refreshIntervalMs)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(timer)
    }
  }, [load, refreshIntervalMs])

  useEffect(() => {
    document.title = t('process_explorer.title')
  }, [t])

  useEffect(() => {
    const closeOnShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        window.close()
      }
    }
    window.addEventListener('keydown', closeOnShortcut)
    return () => window.removeEventListener('keydown', closeOnShortcut)
  }, [])

  const groups = useMemo(() => buildRenderGroups(snapshot, filter), [snapshot, filter])
  const totalCpu = groups.reduce((total, group) => total + group.cpuPercent, 0)
  const totalMemory = groups.reduce((total, group) => total + group.memoryBytes, 0)
  const totalCount = groups.reduce((total, group) => total + group.count, 0)
  const selectedRecord = snapshot?.processes.find(record => record.id === selectedId) ?? null
  const selectedDetail = selectedRecord?.detail
    ? normalizeLaunchDetail(selectedRecord.detail)
    : null
  const selectedLaunch = selectedDetail
    ? splitLaunchDetail(selectedDetail, snapshot?.platform ?? '')
    : null
  const degradedReasons = (snapshot?.degraded ?? []).map(item => describeDegradation(item, t))
  const degradedDetails = (snapshot?.degraded ?? [])
    .map(item => item.detail)
    .filter((detail): detail is string => Boolean(detail))
    .join('\n')

  const toggleOwner = (ownerId: string) => {
    setCollapsedOwners(current => {
      const next = new Set(current)
      if (next.has(ownerId)) next.delete(ownerId)
      else next.add(ownerId)
      return next
    })
  }

  useEffect(() => () => resizeCleanupRef.current?.(), [])

  const copySelectedDetail = async () => {
    if (!selectedRecord || !selectedDetail) return
    try {
      await onCopyText(selectedDetail)
      setCopiedId(selectedRecord.id)
    } catch {
      setCopiedId(null)
    }
  }

  const startResize = (event: ReactPointerEvent<HTMLSpanElement>, index: number) => {
    if (event.button !== 0) return
    const table = tableRef.current
    if (!table || table.clientWidth === 0) return
    event.preventDefault()
    resizeCleanupRef.current?.()

    const startX = event.clientX
    const tableWidth = table.clientWidth
    const startWidths = [...columnWidths]
    const move = (moveEvent: PointerEvent) => {
      const deltaPercent = ((moveEvent.clientX - startX) / tableWidth) * 100
      setColumnWidths(resizeColumnWidths(startWidths, index, deltaPercent))
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      resizeCleanupRef.current = null
    }

    // Document-level listeners keep the drag alive outside the narrow handle
    // and avoid relying on pointer capture across React renders.
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
    resizeCleanupRef.current = cleanup
  }

  const resetColumnWidths = () => setColumnWidths([...DEFAULT_COLUMN_WIDTHS])

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLSpanElement>, index: number) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    setColumnWidths(current =>
      resizeColumnWidths(current, index, event.key === 'ArrowRight' ? 1 : -1)
    )
  }

  return (
    <div
      data-testid="process-explorer-window"
      className="flex h-screen flex-col bg-background text-text-primary"
    >
      <div className="flex items-center gap-3 border-b border-border px-3 py-2">
        <input
          type="search"
          value={filter}
          onChange={event => setFilter(event.target.value)}
          placeholder={t('process_explorer.filter_placeholder')}
          aria-label={t('process_explorer.filter_placeholder')}
          data-testid="process-explorer-filter"
          className="h-7 min-w-0 max-w-64 flex-1 rounded-md border border-border bg-background px-2 text-xs"
        />
        <div className="ml-auto flex min-w-0 flex-1 items-center gap-3 text-xs text-text-secondary">
          <span
            data-testid="process-explorer-summary"
            className="min-w-0 flex-1 truncate text-right tabular-nums"
            title={t('process_explorer.summary_hint')}
          >
            CPU {formatCpu(totalCpu)}% ·{' '}
            {t('process_explorer.summary_memory', { memory: formatMemory(totalMemory) })}
            {' · '}
            {t('process_explorer.summary_processes', { processCount: totalCount })}
          </span>
          <button
            type="button"
            data-testid="process-explorer-always-on-top"
            onClick={onToggleAlwaysOnTop}
            aria-label={t(
              alwaysOnTop
                ? 'process_explorer.always_on_top_active'
                : 'process_explorer.always_on_top'
            )}
            aria-pressed={alwaysOnTop}
            title={t(
              alwaysOnTop
                ? 'process_explorer.always_on_top_active'
                : 'process_explorer.always_on_top'
            )}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md border border-border hover:bg-muted',
              alwaysOnTop && 'bg-muted text-text-primary'
            )}
          >
            <Pin className={cn('h-3.5 w-3.5', alwaysOnTop && 'fill-current')} />
          </button>
          <button
            type="button"
            data-testid="process-explorer-refresh"
            onClick={() => void load()}
            aria-label={t('process_explorer.refresh')}
            title={t('process_explorer.refresh')}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-border hover:bg-muted"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {error ? (
        <div
          data-testid="process-explorer-error"
          className="border-b border-border bg-surface px-3 py-1.5 text-xs text-text-secondary"
        >
          {t('process_explorer.load_failed')}
        </div>
      ) : null}

      {degradedReasons.length > 0 ? (
        <div
          data-testid="process-explorer-degraded"
          title={degradedDetails || undefined}
          className="border-b border-border bg-surface px-3 py-1.5 text-xs text-text-secondary"
        >
          {t('process_explorer.degraded', { reasons: degradedReasons.join('; ') })}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto" data-testid="process-explorer-list">
        <table
          ref={tableRef}
          aria-label={t('process_explorer.title')}
          className="w-full table-fixed border-collapse text-sm"
        >
          <colgroup>
            {columnWidths.map((width, index) => (
              <col
                key={COLUMN_LABELS[index]?.label ?? index}
                data-testid={`process-explorer-column-${index}`}
                style={{ width: `${width}%` }}
              />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-surface text-xs text-text-secondary">
            <tr>
              {COLUMN_LABELS.map((column, index) => (
                <th
                  key={column.label}
                  data-testid={`process-explorer-header-${index}`}
                  className={cn(
                    'relative overflow-hidden py-1.5 font-medium',
                    column.align,
                    column.padding
                  )}
                >
                  {t(column.label)}
                  {index < COLUMN_LABELS.length - 1 ? (
                    <span
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={t('process_explorer.resize_column_hint')}
                      aria-valuemin={8}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(columnWidths[index] ?? 0)}
                      title={t('process_explorer.resize_column_hint')}
                      data-testid={`process-explorer-resize-${index}`}
                      tabIndex={0}
                      onPointerDown={event => startResize(event, index)}
                      onDoubleClick={resetColumnWidths}
                      onKeyDown={event => resizeWithKeyboard(event, index)}
                      className="absolute inset-y-0 right-0 z-20 w-2 cursor-col-resize touch-none select-none after:absolute after:inset-y-1 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border after:content-[''] hover:after:bg-text-muted focus-visible:after:bg-text-muted focus-visible:outline-none"
                    />
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          {groups.length === 0 ? (
            <tbody>
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-xs text-text-muted">
                  {t('process_explorer.empty')}
                </td>
              </tr>
            </tbody>
          ) : (
            groups.map(group => {
              const collapsed = collapsedOwners.has(group.owner.id)
              const ownerKey = group.owner.key ? `process_explorer.owner.${group.owner.key}` : null
              const translatedOwner = ownerKey ? t(ownerKey) : null
              const ownerLabel =
                translatedOwner && translatedOwner !== ownerKey
                  ? translatedOwner
                  : group.owner.label
              return (
                <tbody
                  key={group.owner.id}
                  data-testid={`process-explorer-group-${group.owner.id}`}
                >
                  <tr className="border-b border-border/60 bg-surface/60">
                    <td className="overflow-hidden px-3 py-1.5">
                      <button
                        type="button"
                        data-testid={`process-explorer-toggle-${group.owner.id}`}
                        onClick={() => toggleOwner(group.owner.id)}
                        aria-expanded={!collapsed}
                        className="flex items-center gap-1.5 text-xs font-medium text-text-secondary"
                      >
                        {collapsed ? (
                          <ChevronRight className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" />
                        )}
                        <span>{ownerLabel}</span>
                        <span className="text-text-muted">{group.count}</span>
                      </button>
                    </td>
                    <td />
                    <td className="overflow-hidden px-2 py-1.5 text-right text-xs tabular-nums text-text-secondary">
                      {formatCpu(group.cpuPercent)}
                    </td>
                    <td className="overflow-hidden px-2 py-1.5 text-right text-xs tabular-nums text-text-secondary">
                      {formatMemory(group.memoryBytes)}
                    </td>
                    <td />
                  </tr>
                  {collapsed
                    ? null
                    : group.tree.flatMap(node =>
                        renderNodes(node, 0, t, selectedId, setSelectedId)
                      )}
                </tbody>
              )
            })
          )}
        </table>
      </div>

      <footer
        data-testid="process-explorer-footer"
        className="min-h-10 border-t border-border px-3 py-2 text-xs"
      >
        {selectedRecord ? (
          <div className="flex min-w-0 flex-col gap-1" data-testid="process-explorer-selection">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="truncate font-medium">{selectedRecord.name}</span>
                <span className="shrink-0 text-text-muted">PID {selectedRecord.pid}</span>
              </div>
              {selectedLaunch?.command ? (
                <button
                  type="button"
                  data-testid="process-explorer-copy-launch-details"
                  aria-label={
                    copiedId === selectedRecord.id
                      ? t('process_explorer.copied')
                      : t('process_explorer.copy_launch_details')
                  }
                  title={
                    copiedId === selectedRecord.id
                      ? t('process_explorer.copied')
                      : t('process_explorer.copy_launch_details')
                  }
                  onClick={() => void copySelectedDetail()}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-muted hover:bg-muted hover:text-text-primary"
                >
                  {copiedId === selectedRecord.id ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
              ) : null}
            </div>
            {selectedLaunch?.command ? (
              <div
                data-testid="process-explorer-selection-detail"
                className="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-5 text-text-secondary"
                title={selectedDetail ?? undefined}
              >
                <div>{selectedLaunch.command}</div>
                {selectedLaunch.args ? <div>{selectedLaunch.args}</div> : null}
              </div>
            ) : null}
          </div>
        ) : (
          <span className="text-text-muted">{t('process_explorer.select_process_hint')}</span>
        )}
      </footer>
    </div>
  )
}

function buildRenderGroups(snapshot: ProcessSnapshot | null, filter: string): RenderGroup[] {
  const normalizedFilter = filter.trim().toLowerCase()
  return groupProcesses(snapshot?.processes ?? []).flatMap(group => {
    let tree = buildProcessTree(group.processes)
    if (normalizedFilter) {
      tree = filterProcessTree(tree, record => matchesFilter(record, normalizedFilter))
    }
    const flat = flattenProcessTree(tree)
    if (flat.length === 0) return []
    return [
      {
        owner: group.owner,
        tree,
        count: flat.length,
        cpuPercent: sum(flat.map(node => node.record.cpuPercent)),
        memoryBytes: sum(flat.map(node => node.record.memoryBytes)),
      },
    ]
  })
}

function renderNodes(
  node: ProcessTreeNode,
  depth: number,
  t: (key: string) => string,
  selectedId: string | null,
  select: (id: string) => void
): ReactElement[] {
  const record = node.record
  return [
    <tr
      key={record.id}
      data-testid={`process-explorer-row-${record.pid}`}
      tabIndex={0}
      aria-current={selectedId === record.id ? 'true' : undefined}
      onClick={() => select(record.id)}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        select(record.id)
      }}
      className={cn(
        'cursor-pointer border-b border-border/40 hover:bg-muted/40 focus-visible:bg-muted focus-visible:outline-none',
        selectedId === record.id && 'bg-muted'
      )}
    >
      <td className="overflow-hidden py-1.5 pr-3" style={{ paddingLeft: 32 + depth * 16 }}>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate" title={record.name}>
            {record.name}
          </span>
        </div>
      </td>
      <td className="overflow-hidden px-2 py-1.5 text-right tabular-nums">{record.pid}</td>
      <td className="overflow-hidden px-2 py-1.5 text-right tabular-nums">
        {formatCpu(record.cpuPercent)}
      </td>
      <td className="overflow-hidden px-2 py-1.5 text-right tabular-nums">
        {formatMemory(record.memoryBytes)}
      </td>
      <td className="overflow-hidden px-2 py-1.5 text-right tabular-nums">
        {formatAge(record.startedAt)}
      </td>
    </tr>,
    ...node.children.flatMap(child => renderNodes(child, depth + 1, t, selectedId, select)),
  ]
}

function matchesFilter(record: ProcessRecord, filter: string): boolean {
  if (/^\d+$/.test(filter)) return String(record.pid) === filter
  return (
    record.name.toLowerCase().includes(filter) ||
    record.detail?.toLowerCase().includes(filter) === true
  )
}

function sum(values: readonly (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0)
}
