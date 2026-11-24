import { createResizableController } from '@wegent/collaboration/controls/resizableController'
import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Resizable, ResizablePanel } from '@wegent/collaboration/controls/Resizable'
import { WorkbenchPaneHost } from '@/components/layout/workbenchPanePresentation'
import { cn } from '@/lib/utils'
import { ExperienceHeader } from './ExperienceHeader'
import { PaneResizeHandle } from './PaneResizeHandle'
import {
  createDefaultPaneLayout,
  EXPERIENCE_MOBILE_MAX_WIDTH,
  EXPERIENCE_SEPARATOR_WIDTH,
  paneMinimumWidth,
  selectVisiblePaneIds,
} from './paneLayout'
import type { ExperiencePane, ExperiencePanesProps } from './types'
import { useExperiencePaneHosts } from './useExperiencePaneHosts'
import { useExperiencePaneWidth } from './useExperiencePaneWidth'
import './ExperienceApp.css'

function pointerFocusTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const pane = target.closest<HTMLElement>('.experience-pane')
  if (!pane) return null
  const control = target.closest<HTMLElement>(
    'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex], [contenteditable]:not([contenteditable="false"])'
  )
  if (control && control !== pane && pane.contains(control)) return control
  const active = pane.ownerDocument.activeElement
  return active instanceof HTMLElement && pane.contains(active) ? active : null
}

function ExperiencePaneContent({
  content,
  onBack,
}: {
  content: ExperiencePane['content']
  onBack: () => void
}) {
  return typeof content === 'function' ? content(onBack) : content
}

export function ExperiencePanes({ panes, onBack, className }: ExperiencePanesProps) {
  const container = useRef<HTMLDivElement>(null)
  const [group] = useState(createResizableController)
  const width = useExperiencePaneWidth(container)
  const mobile = width <= EXPERIENCE_MOBILE_MAX_WIDTH
  const availablePanes = mobile ? panes.filter(pane => !pane.desktopOnly) : panes
  const visibleIds = selectVisiblePaneIds(availablePanes, width)
  const visiblePanes = panes.filter(pane => visibleIds.includes(pane.id))
  const signature = panes.map(pane => pane.id).join('\u0000')
  const visibleSignature = visiblePanes.map(pane => pane.id).join('\u0000')
  const hosts = useExperiencePaneHosts(signature)
  const [savedLayouts, setSavedLayouts] = useState<Record<string, Record<string, number>>>({})
  const defaultLayout = createDefaultPaneLayout(visiblePanes, width)
  const lastInteraction = useRef<HTMLElement | null>(null)
  const returnFocus = useRef(new Map<string, HTMLElement>())
  const previousPaneIds = useRef<string[]>([])
  const pendingRestore = useRef<HTMLElement | null>(null)
  const pendingActivation = useRef<string | null>(null)

  useLayoutEffect(() => {
    const ids = signature.split('\u0000').filter(Boolean)
    const previous = previousPaneIds.current
    for (const id of ids) {
      if (!previous.includes(id) && previous.length) {
        if (lastInteraction.current) returnFocus.current.set(id, lastInteraction.current)
        pendingActivation.current = id
      }
    }
    previousPaneIds.current = ids
    const target = pendingRestore.current
    if (target?.isConnected && !target.closest('[hidden]')) {
      target.focus({ preventScroll: true })
      pendingRestore.current = null
      pendingActivation.current = null
    }
    const activationHost = hosts.get(pendingActivation.current ?? '')
    if (activationHost?.isConnected && !activationHost.closest('[hidden]')) {
      activationHost.querySelector<HTMLElement>('.experience-pane')?.focus({ preventScroll: true })
      pendingActivation.current = null
    }
  }, [hosts, signature, visibleSignature])

  const back = (pane: ExperiencePane) => {
    pendingRestore.current =
      pane.returnFocusRef?.current ?? returnFocus.current.get(pane.id) ?? null
    if (pane.onBack) pane.onBack()
    else onBack?.(pane.id)
  }

  return (
    <div
      ref={container}
      className={cn('experience-panes', className)}
      data-testid="collaboration-exp-panes"
      data-mobile={mobile}
      onFocusCapture={event => {
        if (event.target instanceof HTMLElement) lastInteraction.current = event.target
      }}
      onPointerDownCapture={event => {
        lastInteraction.current = pointerFocusTarget(event.target)
      }}
    >
      {visiblePanes.length ? (
        <Resizable
          key={visibleSignature}
          controller={group}
          orientation="horizontal"
          defaultLayout={visiblePanes.map(
            pane => (savedLayouts[visibleSignature] ?? defaultLayout)[pane.id]
          )}
          className="experience-pane-group"
          onLayoutCommit={sizes => {
            const layout = Object.fromEntries(
              visiblePanes.map((pane, index) => [pane.id, sizes[index]])
            )
            setSavedLayouts(current => {
              const saved = current[visibleSignature]
              if (saved && Object.keys(layout).every(id => saved[id] === layout[id])) return current
              return { ...current, [visibleSignature]: layout }
            })
          }}
        >
          {visiblePanes.map((pane, index) => (
            <Fragment key={pane.id}>
              {index > 0 ? (
                <PaneResizeHandle
                  id={`${visiblePanes[index - 1].id}-${pane.id}`}
                  resetLayout={() =>
                    group.setLayout(visiblePanes.map(pane => defaultLayout[pane.id]))
                  }
                />
              ) : null}
              <ResizablePanel
                id={pane.id}
                minSize={`${Math.min(
                  paneMinimumWidth(pane),
                  Math.max(1, width - (visiblePanes.length - 1) * EXPERIENCE_SEPARATOR_WIDTH)
                )}px`}
                className="experience-pane-slot"
                style={{ overflow: 'hidden' }}
              >
                {hosts.has(pane.id) ? <WorkbenchPaneHost host={hosts.get(pane.id)!} /> : null}
              </ResizablePanel>
            </Fragment>
          ))}
        </Resizable>
      ) : null}
      <div hidden aria-hidden="true">
        {panes
          .filter(pane => !visiblePanes.some(visible => visible.id === pane.id))
          .map(pane =>
            hosts.has(pane.id) ? (
              <WorkbenchPaneHost key={pane.id} host={hosts.get(pane.id)!} />
            ) : null
          )}
      </div>
      {panes.map((pane, index) => {
        const host = hosts.get(pane.id)
        if (!host) return null
        const canGoBack = Boolean(pane.onBack || (index > 0 && onBack))
        const goBack = () => back(pane)
        return createPortal(
          <section
            className="experience-pane"
            tabIndex={-1}
            data-testid={`collaboration-exp-pane-${pane.id}`}
          >
            {pane.header !== undefined ? (
              pane.header
            ) : (
              <ExperienceHeader
                title={pane.title}
                actions={pane.actions}
                onBack={canGoBack ? goBack : undefined}
                testId={`collaboration-exp-pane-header-${pane.id}`}
              />
            )}
            <div
              className={cn('experience-pane-body', pane.scroll === false ? '' : 'scrollbar-soft')}
              data-scroll={pane.scroll !== false}
            >
              <ExperiencePaneContent content={pane.content} onBack={goBack} />
            </div>
          </section>,
          host,
          pane.id
        )
      })}
    </div>
  )
}

export type { ExperiencePane, ExperiencePanesProps } from './types'
