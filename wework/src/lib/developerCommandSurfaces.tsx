import { Listbox, ListboxItem } from '@ui-sdk/react/listbox'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { controlOption } from '@wegent/collaboration/controls/recipes'
import { Button } from '@wegent/collaboration/markdown/Button'
import { useCallback, useRef, useState } from 'react'
import {
  clearWorkbenchDebugLogs,
  getWorkbenchDebugSnapshot,
  type WorkbenchDebugSnapshot,
} from './debugPanel'
export interface DeveloperCommand {
  id: string
  label: string
  description: string
  run(): void | Promise<void>
}
let collapsedDebugPanelPosition: { left: number; top: number } | null = null
export function DeveloperCommands({
  getCommands,
  refreshStatus,
  close,
}: {
  getCommands(): DeveloperCommand[]
  refreshStatus(onLoaded: () => void): Promise<void>
  close(): void
}) {
  const [commands, setCommands] = useState(getCommands)
  const loadStatus = useCallback(
    (surface: HTMLDivElement | null) => {
      if (!surface) return
      let active = true
      void refreshStatus(() => {
        if (active) setCommands(getCommands())
      })
      return () => {
        active = false
      }
    },
    [getCommands, refreshStatus]
  )
  return (
    <div
      className="fixed inset-0 z-system-popover flex items-start justify-center bg-black/20 px-4 pt-[12vh]"
      onMouseDown={event => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <DialogSurface
        onClose={close}
        initialFocus="[data-command-id]"
        render={
          <div
            ref={loadStatus}
            aria-label="Developer commands"
            className="w-full max-w-lg rounded-xl border border-border bg-popover p-2 text-text-primary shadow-lg"
          />
        }
      >
        <header className="border-b border-border px-3 py-2">
          <h2 className="text-sm font-semibold">Developer Commands</h2>
          <p className="text-xs text-text-secondary">Cmd+Option+Shift+P</p>
        </header>
        <Listbox
          aria-label="Developer commands"
          activation="manual"
          onValueChange={value => {
            const command = commands.find(command => command.id === value)
            if (command) {
              close()
              void command.run()
            }
          }}
        >
          {commands.map(command => (
            <ListboxItem
              key={command.id}
              value={command.id}
              render={<button type="button" />}
              data-command-id={command.id}
              data-testid={'developer-command-' + command.id}
              className={controlOption}
            >
              <span>
                <span className="block font-medium">{command.label}</span>
                <span className="block text-xs text-text-secondary">{command.description}</span>
              </span>
            </ListboxItem>
          ))}
        </Listbox>
      </DialogSurface>
    </div>
  )
}

export function DebugPanel({
  close,
  emitVisibility,
}: {
  close(): void
  emitVisibility(expanded: boolean): void
}) {
  const [expanded, setExpanded] = useState(true)
  const [snapshot, setSnapshot] = useState(getWorkbenchDebugSnapshot)
  const [position, setPosition] = useState(collapsedDebugPanelPosition)
  const drag = useRef<{
    x: number
    y: number
    left: number
    top: number
    width: number
    height: number
    moved: boolean
  } | null>(null)
  const emitMountedVisibility = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) emitVisibility(expanded)
    },
    [expanded, emitVisibility]
  )
  const refresh = () => setSnapshot(getWorkbenchDebugSnapshot())
  if (!expanded)
    return (
      <div
        ref={emitMountedVisibility}
        className="electron-titlebar-interactive-region fixed z-system-popover"
        style={position ? { left: position.left, top: position.top } : { right: 16, bottom: 16 }}
      >
        <Button
          variant="outline"
          type="button"
          data-testid="debug-panel-collapsed"
          aria-label="Expand debug panel"
          title={'Debug Panel - ' + formatRunningStateLabel(snapshot)}
          className="cursor-grab gap-2"
          onPointerDown={event => {
            if (event.button !== 0) return
            const rect = event.currentTarget.getBoundingClientRect()
            drag.current = {
              x: event.clientX,
              y: event.clientY,
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
              moved: false,
            }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={event => {
            const start = drag.current
            if (!start) return
            const dx = event.clientX - start.x,
              dy = event.clientY - start.y
            if (!start.moved && Math.hypot(dx, dy) < 4) return
            start.moved = true
            const next = {
              left: Math.min(
                Math.max(0, window.innerWidth - start.width),
                Math.max(0, start.left + dx)
              ),
              top: Math.min(
                Math.max(0, window.innerHeight - start.height),
                Math.max(0, start.top + dy)
              ),
            }
            collapsedDebugPanelPosition = next
            setPosition(next)
          }}
          onPointerUp={event => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onPointerCancel={() => {
            drag.current = null
          }}
          onClick={event => {
            if (drag.current?.moved) {
              event.preventDefault()
              drag.current = null
              return
            }
            drag.current = null
            refresh()
            setExpanded(true)
          }}
        >
          <span
            className={
              'h-2 w-2 rounded-full ' +
              (snapshot.workbench?.runningState.activeTaskRunning ? 'bg-primary' : 'bg-border')
            }
          />
          Debug
        </Button>
      </div>
    )
  return (
    <div
      ref={emitMountedVisibility}
      className="electron-titlebar-interactive-region fixed inset-0 z-system-popover flex items-stretch justify-center bg-black/30 p-4"
      onMouseDown={event => {
        if (event.target === event.currentTarget) setExpanded(false)
      }}
    >
      <DialogSurface
        onClose={() => setExpanded(false)}
        render={
          <div
            aria-label="Debug panel"
            className="flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-background text-text-primary shadow-lg"
          />
        }
      >
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Debug Panel</h2>
            <p className="text-xs text-text-secondary">Active task state and console.debug logs</p>
          </div>
          <div className="flex items-center gap-2">
            {[
              { label: 'Refresh', run: refresh },
              {
                label: 'Copy Snapshot',
                run: () => {
                  void copyDebugSnapshot(getWorkbenchDebugSnapshot())
                },
              },
              {
                label: 'Clear Logs',
                run: () => {
                  clearWorkbenchDebugLogs()
                  refresh()
                },
              },
              { label: 'Collapse', run: () => setExpanded(false) },
              { label: 'Close', run: close },
            ].map(({ label, run }) => (
              <Button
                key={label}
                variant="outline"
                size="sm"
                type="button"
                data-testid={'debug-panel-' + label.toLowerCase().replaceAll(' ', '-')}
                onClick={run}
              >
                {label}
              </Button>
            ))}
          </div>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-2">
          <DebugSection
            title={'Active Task State (' + formatRunningStateLabel(snapshot) + ')'}
            content={formatDebugJson(snapshot)}
          />
          <DebugSection title="Memory Diagnostics" content={formatMemoryDiagnostics(snapshot)} />
          <MessageStyleComparison snapshot={snapshot} />
          <DebugSection
            title={'Debug Logs (' + snapshot.logs.length + '/' + snapshot.logLimit + ')'}
            content={formatDebugLogs(snapshot)}
          />
        </div>
      </DialogSurface>
    </div>
  )
}

function DebugSection({ title, content }: { title: string; content: string }) {
  return (
    <section className="flex min-h-0 flex-col border-b border-border lg:border-r">
      <h3 className="border-b border-border px-4 py-2 text-xs font-medium text-text-secondary">
        {title}
      </h3>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5">
        {content}
      </pre>
    </section>
  )
}

function MessageStyleComparison({ snapshot }: { snapshot: WorkbenchDebugSnapshot }) {
  const comparison = snapshot.pane?.messageStyleComparison
  return (
    <section className="flex min-h-0 flex-col border-b border-border lg:border-r">
      <h3 className="border-b border-border px-4 py-2 text-xs font-medium text-text-secondary">
        Transcript vs Streaming Style
      </h3>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {!comparison ? (
          <p className="text-xs text-text-secondary">No pane snapshot has been captured yet.</p>
        ) : (
          <>
            <div className="grid gap-3 xl:grid-cols-2">
              {(
                [
                  ['Transcript Loaded', comparison.transcriptLoaded],
                  ['Current Streaming', comparison.currentStreaming],
                ] as const
              ).map(([title, sample]) => (
                <div key={title} className="rounded-lg border border-border p-3">
                  <h4 className="text-xs font-semibold">{title}</h4>
                  {sample ? (
                    <>
                      <pre className="mt-2 whitespace-pre-wrap text-xs text-text-secondary">
                        {[
                          'id: ' + sample.id,
                          'status: ' + sample.status,
                          'runtimeStatus: ' + (sample.runtimeStatus ?? 'null'),
                          'runtimeMessageIndex: ' + (sample.runtimeMessageIndex ?? 'null'),
                          'subtaskId: ' + (sample.subtaskId ?? 'null'),
                          'blocks: ' +
                            sample.blockCount +
                            ' (' +
                            sample.runningBlockCount +
                            ' running)',
                          'completedAt: ' + (sample.completedAt ?? 'null'),
                        ].join('\n')}
                      </pre>
                      <p className="mt-3 max-h-32 overflow-auto rounded-lg bg-muted p-3 text-xs">
                        {sample.contentPreview}
                      </p>
                      <ul className="mt-3 list-disc pl-4 text-xs text-text-secondary">
                        {sample.expectedUi.map(rule => (
                          <li key={rule}>{rule}</li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="mt-2 text-xs text-text-secondary">
                      No matching message in the current pane.
                    </p>
                  )}
                </div>
              ))}
            </div>
            <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface p-3 text-xs">
              {JSON.stringify(
                { fieldDiff: comparison.fieldDiff, renderingRules: comparison.renderingRules },
                null,
                2
              )}
            </pre>
          </>
        )}
      </div>
    </section>
  )
}

function formatRunningStateLabel(snapshot: WorkbenchDebugSnapshot): string {
  const workbenchRunning = snapshot.workbench?.runningState
  const paneStatus = snapshot.pane?.status
  if (!workbenchRunning?.hasCurrentRuntimeTask) return 'no active runtime task'

  return [
    `taskKnown=${workbenchRunning.activeTaskKnown}`,
    `taskRunning=${String(workbenchRunning.activeTaskRunning)}`,
    `taskStatus=${workbenchRunning.activeTaskStatus ?? 'null'}`,
    `paneRunning=${String(paneStatus?.taskExecution.running ?? null)}`,
    `paneBusy=${String(paneStatus?.isBusy ?? null)}`,
    `sendPhase=${paneStatus?.sendPhase ?? 'null'}`,
  ].join(' / ')
}

function formatDebugJson(snapshot: WorkbenchDebugSnapshot): string {
  return JSON.stringify(
    {
      updatedAt: snapshot.updatedAt,
      workbench: snapshot.workbench,
      pane: snapshot.pane,
    },
    null,
    2
  )
}

function formatMemoryDiagnostics(snapshot: WorkbenchDebugSnapshot): string {
  const memory = snapshot.pane?.memory
  if (!memory) return 'No runtime pane memory snapshot has been captured yet.'

  return JSON.stringify(memory, null, 2)
}

function formatDebugLogs(snapshot: WorkbenchDebugSnapshot): string {
  if (snapshot.logs.length === 0) return 'No console.debug logs captured yet.'

  return snapshot.logs
    .map(log => {
      const message = log.args.join(' ')
      return `[${log.timestamp}] ${message}`
    })
    .join('\n')
}

async function copyDebugSnapshot(snapshot: WorkbenchDebugSnapshot) {
  const text = JSON.stringify(snapshot, null, 2)
  try {
    await navigator.clipboard.writeText(text)
  } catch (error) {
    console.warn('[Wework dev] Failed to copy debug snapshot', error)
  }
}
