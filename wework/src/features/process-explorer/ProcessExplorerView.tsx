import { usePanelResizeDrag } from '@/components/layout/usePanelResizeDrag'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { useDocumentEvent, useWindowEvent } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import type {
  ProcessExplorerClient,
  ProcessOwnerRef,
  ProcessSnapshot,
} from '@wegent/process-explorer'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Pin,
  RefreshCw,
} from 'lucide-react'
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
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
  DEFAULT_PROCESS_SORT,
  isExited,
  type ProcessRow,
  type ProcessSort,
  type ProcessTreeNode,
  type SortColumn,
} from './processTree'

export interface ProcessExplorerViewProps {
  client: ProcessExplorerClient
  alwaysOnTop: boolean
  onToggleAlwaysOnTop: () => void
  onCopyText: (text: string) => Promise<void>
  refreshIntervalMs?: number
}

const DEFAULT_REFRESH_INTERVAL_MS = 1000

interface ProcessColumn {
  key: SortColumn
  label: string
  align: 'text-left' | 'text-right'
  padding: string
}

const COLUMNS: readonly ProcessColumn[] = [
  {
    key: 'name',
    label: 'process_explorer.column_process',
    align: 'text-left',
    padding: 'pl-3 pr-3',
  },
  { key: 'pid', label: 'process_explorer.column_pid', align: 'text-right', padding: 'pl-2 pr-3' },
  { key: 'cpu', label: 'process_explorer.column_cpu', align: 'text-right', padding: 'pl-2 pr-3' },
  {
    key: 'memory',
    label: 'process_explorer.column_memory',
    align: 'text-right',
    padding: 'pl-2 pr-3',
  },
  {
    key: 'uptime',
    label: 'process_explorer.column_uptime',
    align: 'text-right',
    padding: 'pl-2 pr-3',
  },
]

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
  const [filter, setFilter] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [collapsedOwners, setCollapsedOwners] = useState<Set<string>>(() => new Set())
  const [columnWidths, setColumnWidths] = useState<number[]>(() => [...DEFAULT_COLUMN_WIDTHS])
  const [sort, setSort] = useState<ProcessSort>(DEFAULT_PROCESS_SORT)
  const tableRef = useRef<HTMLTableElement>(null)
  const { startResize: startPanelResize, stopResize } = usePanelResizeDrag()

  const source = useMemo(
    () => createProcessSnapshotSource(client, refreshIntervalMs),
    [client, refreshIntervalMs]
  )
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const snapshot = state.data?.snapshot ?? null
  const error = state.error ?? null
  const load = source.reload
  // A hidden window stops sampling; the first frame after it is shown is fresh.
  useDocumentEvent('visibilitychange', () => {
    if (!document.hidden) void load()
  })
  useWindowEvent('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') {
      event.preventDefault()
      window.close()
    }
  })

  const groups = useMemo(() => buildRenderGroups(snapshot, filter, sort), [snapshot, filter, sort])
  const totalCpu = groups.reduce((total, group) => total + group.cpuPercent, 0)
  const totalMemory = groups.reduce((total, group) => total + group.memoryBytes, 0)
  const totalCount = groups.reduce((total, group) => total + group.count, 0)
  const selectedRecord =
    snapshot?.processes.concat(snapshot.recentlyExited).find(record => record.id === selectedId) ??
    null
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

  const bindTable = useCallback(
    (table: HTMLTableElement | null) => {
      tableRef.current = table
      return () => {
        stopResize()
        tableRef.current = null
      }
    },
    [stopResize]
  )

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
    stopResize()
    const startX = event.clientX
    const tableWidth = table.clientWidth
    const startWidths = [...columnWidths]
    startPanelResize(event, {
      cursor: 'col-resize',
      onMove: ({ x }) => {
        const deltaPercent = ((x - startX) / tableWidth) * 100
        setColumnWidths(resizeColumnWidths(startWidths, index, deltaPercent))
      },
    })
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
      <title>{t('process_explorer.title')}</title>
      <div className="flex items-center gap-3 border-b border-border px-3 py-2">
        <ControlInput
          density="dense"
          type="search"
          value={filter}
          onChange={event => setFilter(event.target.value)}
          placeholder={t('process_explorer.filter_placeholder')}
          aria-label={t('process_explorer.filter_placeholder')}
          data-testid="process-explorer-filter"
          className="min-w-0 max-w-64 flex-1 text-xs"
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
          <ControlButton
            variant="unstyled"
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
          </ControlButton>
          <ControlButton
            variant="outline"
            size="sm"
            type="button"
            data-testid="process-explorer-refresh"
            onClick={() => void load()}
            aria-label={t('process_explorer.refresh')}
            title={t('process_explorer.refresh')}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-border hover:bg-muted"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </ControlButton>
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

      {snapshot?.collectingSystemProcesses ? (
        <div
          data-testid="process-explorer-collecting"
          className="border-b border-border px-3 py-1.5 text-xs text-text-secondary"
        >
          {t('process_explorer.collecting_system_processes')}
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
          ref={bindTable}
          aria-label={t('process_explorer.title')}
          className="w-full table-fixed border-collapse text-sm"
        >
          <colgroup>
            {columnWidths.map((width, index) => (
              <col
                key={COLUMNS[index]?.key ?? index}
                data-testid={`process-explorer-column-${index}`}
                style={{ width: `${width}%` }}
              />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-surface text-xs text-text-secondary">
            <tr>
              {COLUMNS.map((column, index) => {
                const sorted = sort.column === column.key
                return (
                  <th
                    key={column.key}
                    data-testid={`process-explorer-header-${index}`}
                    aria-sort={
                      sorted ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined
                    }
                    className={cn(
                      'relative overflow-hidden py-1.5 font-medium',
                      column.align,
                      column.padding
                    )}
                  >
                    <ControlButton
                      variant="unstyled"
                      type="button"
                      data-testid={`process-explorer-sort-${column.key}`}
                      onClick={() =>
                        setSort(current =>
                          current.column === column.key
                            ? {
                                column: column.key,
                                direction: current.direction === 'asc' ? 'desc' : 'asc',
                              }
                            : {
                                column: column.key,
                                direction:
                                  column.key === 'name' || column.key === 'pid' ? 'asc' : 'desc',
                              }
                        )
                      }
                      aria-label={t('process_explorer.sort_by', { column: t(column.label) })}
                      title={t('process_explorer.sort_by', { column: t(column.label) })}
                      className={cn(
                        'flex w-full items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30',
                        column.align === 'text-right' ? 'justify-end' : 'justify-start',
                        sorted ? 'text-text-primary' : 'hover:text-text-primary'
                      )}
                    >
                      <span>{t(column.label)}</span>
                      {sorted ? (
                        sort.direction === 'asc' ? (
                          <ArrowUp className="h-3 w-3 shrink-0" />
                        ) : (
                          <ArrowDown className="h-3 w-3 shrink-0" />
                        )
                      ) : null}
                    </ControlButton>
                    {index < COLUMNS.length - 1 ? (
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
                )
              })}
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
                      <ControlButton
                        variant="unstyled"
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
                      </ControlButton>
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
                <ControlButton
                  variant="unstyled"
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
                </ControlButton>
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

interface SnapshotRead {
  snapshot: ProcessSnapshot
  sequence: number
  startedAt: number
}
interface SnapshotFailure {
  cause: unknown
  sequence: number
  startedAt: number
}
let nextSnapshotSequence = 0

function createProcessSnapshotSource(client: ProcessExplorerClient, refreshIntervalMs: number) {
  return createAsyncResource<SnapshotRead>(
    'process-explorer-snapshot',
    async signal => {
      const sequence = ++nextSnapshotSequence
      const startedAt = Date.now()
      traceSnapshotLoad('requested', sequence, startedAt)
      try {
        const snapshot = await client.snapshot({ waitForSystemProcesses: false })
        if (signal.aborted)
          traceSnapshotLoad('received', sequence, startedAt, {
            accepted: false,
            processCount: snapshot.processes.length,
            degraded: snapshot.degraded.map(item => item.code),
          })
        return { snapshot, sequence, startedAt }
      } catch (cause) {
        if (signal.aborted)
          traceSnapshotLoad('failed', sequence, startedAt, {
            accepted: false,
            errorName: cause instanceof Error ? cause.name : typeof cause,
          })
        throw { cause, sequence, startedAt } satisfies SnapshotFailure
      }
    },
    {
      refreshIntervalMs,
      refreshIntervalMode: 'after-settle',
      refreshEnabled: () => !document.hidden,
      success({ snapshot, sequence, startedAt }) {
        traceSnapshotLoad('received', sequence, startedAt, {
          accepted: true,
          processCount: snapshot.processes.length,
          degraded: snapshot.degraded.map(item => item.code),
        })
      },
      failure(error) {
        const { cause, sequence, startedAt } = error as SnapshotFailure
        traceSnapshotLoad('failed', sequence, startedAt, {
          accepted: true,
          errorName: cause instanceof Error ? cause.name : typeof cause,
        })
      },
    }
  )
}

function traceSnapshotLoad(
  stage: string,
  sequence: number,
  startedAt: number,
  details: Record<string, unknown> = {}
): void {
  if (import.meta.env.MODE !== 'e2e' && import.meta.env.VITE_WEWORK_E2E !== 'true') return
  console.debug(
    '[process-explorer-snapshot] ' +
      JSON.stringify({
        stage,
        sequence,
        startedAt,
        elapsedMs: Date.now() - startedAt,
        ...details,
      })
  )
}

function buildRenderGroups(
  snapshot: ProcessSnapshot | null,
  filter: string,
  sort: ProcessSort
): RenderGroup[] {
  const normalizedFilter = filter.trim().toLowerCase()
  // Exited processes stay in the tree while they fade, so a short-lived child
  // remains visible under the parent that forked it.
  const rows = snapshot?.processes.concat(snapshot.recentlyExited) ?? []
  return groupProcesses(rows).flatMap(group => {
    let tree = buildProcessTree(group.processes, sort)
    if (normalizedFilter) {
      tree = filterProcessTree(tree, record => matchesFilter(record, normalizedFilter))
    }
    const flat = flattenProcessTree(tree)
    if (flat.length === 0) return []
    const running = flat.filter(node => !isExited(node.record))
    return [
      {
        owner: group.owner,
        tree,
        count: running.length,
        cpuPercent: sum(running.map(node => node.record.cpuPercent)),
        memoryBytes: sum(running.map(node => node.record.memoryBytes)),
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
  const exited = isExited(record)
  return [
    <tr
      key={record.id}
      data-testid={`process-explorer-row-${record.pid}`}
      data-state={exited ? 'exited' : undefined}
      tabIndex={0}
      aria-current={selectedId === record.id ? 'true' : undefined}
      onClick={() => select(record.id)}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        select(record.id)
      }}
      className={cn(
        'cursor-pointer border-b border-border/40 transition-opacity duration-300 hover:bg-muted/40 focus-visible:bg-muted focus-visible:outline-none',
        selectedId === record.id && 'bg-muted',
        exited && 'text-text-muted opacity-60'
      )}
    >
      <td className="overflow-hidden py-1.5 pr-3" style={{ paddingLeft: 32 + depth * 16 }}>
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="truncate"
            title={exited ? `${record.name} · ${t('process_explorer.exited')}` : record.name}
          >
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
        {formatAge(record.startedAt, exited ? record.exitedAt : undefined)}
      </td>
    </tr>,
    ...node.children.flatMap(child => renderNodes(child, depth + 1, t, selectedId, select)),
  ]
}

function matchesFilter(record: ProcessRow, filter: string): boolean {
  if (/^\d+$/.test(filter)) return String(record.pid) === filter
  return (
    record.name.toLowerCase().includes(filter) ||
    record.detail?.toLowerCase().includes(filter) === true
  )
}

function sum(values: readonly (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0)
}
