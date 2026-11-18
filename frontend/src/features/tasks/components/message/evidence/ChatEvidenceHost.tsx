// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

'use client'

import {
  createContext,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { TaskRightPanelRequest } from '../../right-panel'

type PanelOwner = { dismiss: () => void }

interface EvidenceHost {
  mobile: boolean
  suspended: boolean
  taskKey?: string | null
  hasPanel: boolean
  sideSlot: HTMLDivElement | null
  isPanelOpen: () => boolean
  open: (owner: PanelOwner) => void
  release: (owner: PanelOwner) => void
}

export const ChatEvidenceContext = createContext<EvidenceHost | null>(null)

const MIN_SPLIT_WIDTH = 960

export function ChatEvidenceHost({
  children,
  mobile = false,
  taskKey,
  canSplit = true,
  rightCompanion,
  suspended = false,
  otherPanelRequest,
  onPanelChange,
}: {
  children: ReactNode
  mobile?: boolean
  taskKey?: string | null
  canSplit?: boolean
  rightCompanion?: ReactNode
  suspended?: boolean
  otherPanelRequest?: TaskRightPanelRequest | null
  onPanelChange?: (open: boolean) => void
}) {
  const region = useRef<HTMLDivElement>(null)
  const active = useRef<PanelOwner | null>(null)
  const [hasPanel, setHasPanel] = useState(false)
  const [wide, setWide] = useState(false)
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  const split = !mobile && canSplit && wide && !otherPanelRequest

  useLayoutEffect(() => {
    const element = region.current
    if (!element || mobile) return
    const measure = () => setWide(element.clientWidth >= MIN_SPLIT_WIDTH)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [mobile])

  const open = useCallback(
    (owner: PanelOwner) => {
      if (active.current === owner) return
      active.current?.dismiss()
      active.current = owner
      setHasPanel(true)
      onPanelChange?.(true)
    },
    [onPanelChange]
  )

  const release = useCallback(
    (owner: PanelOwner) => {
      if (active.current !== owner) return
      active.current = null
      setHasPanel(false)
      onPanelChange?.(false)
    },
    [onPanelChange]
  )
  const isPanelOpen = useCallback(() => active.current !== null, [])

  useLayoutEffect(() => {
    if (otherPanelRequest || suspended) active.current?.dismiss()
  }, [otherPanelRequest, suspended])

  return (
    <ChatEvidenceContext.Provider
      value={{
        mobile,
        suspended,
        taskKey,
        hasPanel,
        sideSlot: split ? slot : null,
        isPanelOpen,
        open,
        release,
      }}
    >
      <div ref={region} className="flex min-h-0 min-w-0 flex-1" data-testid="chat-evidence-host">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        <div
          ref={setSlot}
          hidden={!split || !hasPanel}
          className="w-[380px] shrink-0 overflow-hidden border-l border-border bg-surface"
          data-task-right-panel={split && hasPanel ? '' : undefined}
          data-testid="answer-evidence-side-slot"
        />
        {rightCompanion && (
          <div hidden={hasPanel} className={hasPanel ? 'hidden' : 'contents'}>
            {rightCompanion}
          </div>
        )}
      </div>
    </ChatEvidenceContext.Provider>
  )
}
