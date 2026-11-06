import type { RuntimeWorkListResponse } from '@/types/api'
import { getDesktopE2ERuntimeConfig } from '@/e2e/runtime-config'

export function debugRuntimeSidebarState(
  event: string,
  details: Record<string, unknown> | (() => Record<string, unknown> | null)
): void {
  if (
    !getDesktopE2ERuntimeConfig().controlUrl &&
    globalThis.localStorage?.getItem('wework:debug-runtime') !== '1'
  )
    return

  const entry = typeof details === 'function' ? details() : details
  if (!entry) return
  console.debug('[Wework] Runtime sidebar state', {
    event,
    ...entry,
  })
}

function diagnosticRect(element: Element) {
  const { top, bottom, left, right, width, height } = element.getBoundingClientRect()
  return { top, bottom, left, right, width, height }
}

export function runtimeSidebarScrollMetrics(
  viewport: HTMLElement | null,
  activeRow: Element | null
) {
  if (!viewport) return null
  const viewportRect = diagnosticRect(viewport)
  const activeRowRect = activeRow ? diagnosticRect(activeRow) : null
  return {
    scrollTop: viewport.scrollTop,
    scrollHeight: viewport.scrollHeight,
    clientHeight: viewport.clientHeight,
    loadStatusPresent: viewport.querySelector('[data-testid="runtime-work-load-status"]') !== null,
    viewportRect,
    activeRowRect,
    activeRowInsideViewport: activeRow ? viewport.contains(activeRow) : null,
    activeRowContentTop: activeRowRect
      ? activeRowRect.top - viewportRect.top + viewport.scrollTop
      : null,
  }
}

type SidebarScrollMetrics = NonNullable<ReturnType<typeof runtimeSidebarScrollMetrics>>

function sidebarGeometryChanged(previous: SidebarScrollMetrics, next: SidebarScrollMetrics) {
  return (
    previous.scrollHeight !== next.scrollHeight ||
    previous.clientHeight !== next.clientHeight ||
    previous.loadStatusPresent !== next.loadStatusPresent ||
    previous.viewportRect.top !== next.viewportRect.top ||
    previous.viewportRect.height !== next.viewportRect.height ||
    previous.viewportRect.width !== next.viewportRect.width ||
    previous.activeRowInsideViewport !== next.activeRowInsideViewport ||
    (previous.activeRowContentTop === null) !== (next.activeRowContentTop === null) ||
    Math.abs((previous.activeRowContentTop ?? 0) - (next.activeRowContentTop ?? 0)) > 1
  )
}

export class RuntimeSidebarScrollDiagnostics {
  private previous: SidebarScrollMetrics | null = null
  private lastLoggedAt: number | null = null
  private suppressedEvents = 0

  record(readMetrics: () => SidebarScrollMetrics | null, context: Record<string, unknown>) {
    debugRuntimeSidebarState('worklists-scroll', () => {
      const metrics = readMetrics()
      if (!metrics) return null
      const previous = this.previous
      this.previous = metrics
      const geometryChanged = previous !== null && sidebarGeometryChanged(previous, metrics)
      const now = performance.now()
      if (!geometryChanged && this.lastLoggedAt !== null && now - this.lastLoggedAt < 250) {
        this.suppressedEvents += 1
        return null
      }
      const suppressedEvents = this.suppressedEvents
      this.suppressedEvents = 0
      this.lastLoggedAt = now
      return { ...context, metrics, previous, geometryChanged, suppressedEvents }
    })
  }
}

export function summarizeRuntimeWorkTaskIds(runtimeWork: RuntimeWorkListResponse | null) {
  if (!runtimeWork) return { projects: [], chats: [] }

  return {
    projects: runtimeWork.projects.map(projectWork => ({
      projectId: projectWork.project.id ?? null,
      projectKey: projectWork.project.key ?? null,
      taskIds: projectWork.deviceWorkspaces.flatMap(workspace =>
        workspace.tasks.map(task => task.taskId)
      ),
    })),
    chats: runtimeWork.chats.flatMap(workspace => workspace.tasks.map(task => task.taskId)),
  }
}
