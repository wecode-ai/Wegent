// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react'

export interface ProjectShellActionRefs {
  add: RefObject<HTMLButtonElement | null>
  search: RefObject<HTMLButtonElement | null>
}

export interface ProjectShellRenderContext {
  level: number
  showLabels: boolean
  actionRefs: ProjectShellActionRefs
}

export interface ProjectShellViewSwitcherContext {
  compact: boolean
  containerRef: Ref<HTMLElement>
}

export interface ProjectShellAssistantAction {
  icon: ReactNode
  label: string
  onClick(): void
  renderTooltip?(children: ReactNode, label: string): ReactNode
}

export interface ProjectShellProps {
  assistantAction?: ProjectShellAssistantAction
  assistantOpen: boolean
  backAction?: ReactNode
  boardView: boolean
  children: ReactNode
  dragRegion?: ReactNode
  embedded: boolean
  hasCreateAction: boolean
  sidebarCollapsed: boolean
  title: ReactNode
  titleIcon: ReactNode
  renderRightActions(context: ProjectShellRenderContext): ReactNode
  renderViewSwitcher(context: ProjectShellViewSwitcherContext): ReactNode
  searchPanel?: ReactNode
}

export interface ProjectShellResponsiveWidths {
  add: number
  assistant: number
  available: number
  search: number
  title: number
  viewSwitcher: number
}

export function resolveProjectShellLevel({
  assistantOpen,
  boardView,
  hasCreateAction,
  widths,
}: {
  assistantOpen: boolean
  boardView: boolean
  hasCreateAction: boolean
  widths: ProjectShellResponsiveWidths
}): number {
  const compactViewSwitcherWidth = 96
  const compactControlWidth = 48
  const overflowWidth = !assistantOpen || boardView ? compactControlWidth : 0
  const compactAddWidth = boardView && hasCreateAction ? compactControlWidth : 0

  const usedWidthAt = (candidateLevel: number): number => {
    let used = candidateLevel < 2 ? widths.title + 8 : 0
    used += candidateLevel < 2 ? widths.viewSwitcher : compactViewSwitcherWidth
    if (candidateLevel >= 2) return used + overflowWidth + compactAddWidth
    used += candidateLevel >= 1 ? compactControlWidth : widths.search
    if (!assistantOpen) {
      used += candidateLevel >= 1 ? compactControlWidth : widths.assistant
    }
    used += candidateLevel >= 1 ? compactControlWidth : widths.add
    return used
  }

  let level = 0
  while (level < 2 && usedWidthAt(level) > widths.available) level += 1
  return level
}

export function ProjectShell({
  assistantAction,
  assistantOpen,
  backAction,
  boardView,
  children,
  dragRegion,
  embedded,
  hasCreateAction,
  renderRightActions,
  renderViewSwitcher,
  searchPanel,
  sidebarCollapsed,
  title,
  titleIcon,
}: ProjectShellProps) {
  const headerRef = useRef<HTMLElement>(null)
  const titleRef = useRef<HTMLDivElement>(null)
  const viewSwitcherRef = useRef<HTMLElement>(null)
  const assistantRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLButtonElement>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const naturalWidthsRef = useRef({
    add: 0,
    assistant: 0,
    search: 0,
    title: 0,
    viewSwitcher: 0,
  })
  const [level, setLevel] = useState(0)

  useLayoutEffect(() => {
    const header = headerRef.current
    const titleElement = titleRef.current
    if (!header || !titleElement) return

    const compute = () => {
      if (header.clientWidth <= 0) return
      const style = getComputedStyle(header)
      const availableWidth =
        header.clientWidth -
        (parseFloat(style.paddingLeft) || 0) -
        (parseFloat(style.paddingRight) || 0)
      const rememberWidth = (
        key: keyof typeof naturalWidthsRef.current,
        element: HTMLElement | null
      ) => {
        const measured = element?.getBoundingClientRect().width ?? 0
        if (measured > naturalWidthsRef.current[key]) {
          naturalWidthsRef.current[key] = measured
        }
        return naturalWidthsRef.current[key] > 0 ? naturalWidthsRef.current[key] + 8 : 0
      }
      const titleWidth = rememberWidth('title', titleElement)
      const viewSwitcherWidth = rememberWidth('viewSwitcher', viewSwitcherRef.current)
      const assistantWidth = assistantOpen ? 0 : rememberWidth('assistant', assistantRef.current)
      const searchWidth = rememberWidth('search', searchRef.current)
      const addWidth = rememberWidth('add', addRef.current)
      setLevel(
        resolveProjectShellLevel({
          assistantOpen,
          boardView,
          hasCreateAction,
          widths: {
            add: addWidth,
            assistant: assistantWidth,
            available: availableWidth,
            search: searchWidth,
            title: titleWidth,
            viewSwitcher: viewSwitcherWidth,
          },
        })
      )
    }

    compute()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(compute)
    observer.observe(header)
    return () => observer.disconnect()
  })

  const assistantButton =
    assistantAction && !assistantOpen && level < 2 ? (
      <button
        ref={assistantRef}
        type="button"
        data-testid="cloud-project-ask-ai"
        aria-label={assistantAction.label}
        onClick={assistantAction.onClick}
        className="electron-titlebar-interactive-region relative z-10 ml-2 flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-background px-3 text-sm font-medium text-text-primary transition hover:bg-muted"
      >
        {assistantAction.icon}
        {level < 1 ? assistantAction.label : null}
      </button>
    ) : null

  return (
    <>
      <header
        ref={headerRef}
        data-testid="cloud-project-header"
        className={`relative z-10 flex h-[52px] shrink-0 items-center border-b border-border bg-background pr-6 ${
          !embedded && sidebarCollapsed ? 'pl-[240px]' : 'pl-6'
        }`}
      >
        {dragRegion}
        {backAction}
        <div
          ref={titleRef}
          data-testid="cloud-project-header-title"
          className={`relative z-10 min-w-0 items-center ${level < 2 ? 'flex' : 'hidden'}`}
        >
          {titleIcon}
          <span className="ml-2 min-w-0 truncate text-base font-semibold">{title}</span>
        </div>
        {renderViewSwitcher({
          compact: level >= 2,
          containerRef: viewSwitcherRef,
        })}
        <span className="flex-1" />
        {assistantAction?.renderTooltip && assistantButton
          ? assistantAction.renderTooltip(assistantButton, assistantAction.label)
          : assistantButton}
        {renderRightActions({
          actionRefs: {
            add: addRef,
            search: searchRef,
          },
          level,
          showLabels: level < 1,
        })}
        {searchPanel}
      </header>
      {children}
    </>
  )
}
