import { useDOMEvent } from '../dom-events'
import { TransferContext, type Item } from './projectBoardTransferContext'
import { useCollaborationPortalTheme } from '../theme'
import { applyCollaborationPortalTheme } from '../theme/applyPortalTheme'
import { usePart, usePrimitive } from '@ui-sdk/react/primitive'
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { keepFocus, type TransferLists } from '@ui-sdk/core'
import { boardTransferPrimitive } from './boardTransferPrimitive'
import type { ProjectBoardDrop, ProjectBoardDragItem } from './projectBoardDnd'
import { projectBoardDrop } from './projectBoardDnd'

export interface ProjectBoardTransferEvents {
  onDragStart?(source: ProjectBoardDragItem): void
  onDrop?(drop: ProjectBoardDrop): void
  onDragCancel?(): void
}

export function ProjectBoardTransfer({
  children,
  onDragStart,
  onDrop,
  onDragCancel,
}: ProjectBoardTransferEvents & { children?: ReactNode }) {
  const theme = useCollaborationPortalTheme()
  const destinationRef = useRef<{ itemId: string; list: string } | null>(null)
  const release = useRef<globalThis.PointerEvent | null>(null)
  const [items, setItems] = useState<ReadonlyMap<string, Item>>(() => new Map())
  const [containers, setContainers] = useState<ReadonlyMap<string, HTMLElement>>(() => new Map())
  const registerItem = useCallback((key: string, item: Item) => {
    setItems(current => new Map(current).set(key, item))
    return () =>
      setItems(current => {
        const next = new Map(current)
        next.delete(key)
        return next
      })
  }, [])
  const registerList = useCallback((key: string, node: HTMLElement) => {
    node.dataset.issueBoardTransferList = key
    setContainers(current => new Map(current).set(key, node))
    return () => {
      delete node.dataset.issueBoardTransferList
      setContainers(current => {
        const next = new Map(current)
        next.delete(key)
        return next
      })
    }
  }, [])
  const readLists = useCallback(() => {
    const next: TransferLists = {}
    for (const key of containers.keys()) next[key] = []
    const ordered = Array.from(items).sort(([, a], [, b]) =>
      a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    )
    for (const [key, item] of ordered) {
      const container = item.node.closest<HTMLElement>('[data-issue-board-transfer-list]')
      const list = container?.dataset.issueBoardTransferList
      if (list && next[list]) next[list].push(key)
    }
    return next
  }, [containers, items])
  const active = (key: string): ProjectBoardDragItem => ({
    id: key,
    ...items.get(key)?.data,
  })
  const handle = usePrimitive(boardTransferPrimitive, {
    readLists,
    onStart: ({ key, pointer }) => {
      release.current = null
      if (pointer) {
        const source = items.get(key)?.node
        // Transfer appends its preview after the synchronous start notification.
        queueMicrotask(() => {
          const previews =
            source?.ownerDocument.querySelectorAll<HTMLElement>('[data-drag-preview]')
          const copy = previews?.[previews.length - 1]
          if (!copy) return
          for (const node of copy.querySelectorAll('[data-testid]'))
            node.removeAttribute('data-testid')
          copy.setAttribute('data-testid', 'project-board-drag-overlay')
          applyCollaborationPortalTheme(copy, theme)
        })
      }
      onDragStart?.(active(key))
    },
    onCancel: () => onDragCancel?.(),
    recover: itemId => {
      const destination = destinationRef.current
      if (!destination || destination.itemId !== itemId) return undefined
      return (
        containers
          .get(destination.list)
          ?.querySelector<HTMLElement>(`[data-board-transfer-item="${CSS.escape(itemId)}"]`) ??
        undefined
      )
    },
    onCommit: (nextLists, details) => {
      if (!onDrop) return false
      if (details.reason === 'drag') {
        const event = release.current
        const rect = containers.get(details.to)?.getBoundingClientRect()
        if (
          !event ||
          !rect ||
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          return false
      }
      const destination = (nextLists[details.to] ?? []).filter(key => key !== details.key)
      const before = destination[details.index]
      const source = items.get(details.key)
      const itemId = source?.data.itemId
      const followsFocus = Boolean(source?.node.contains(source.node.ownerDocument.activeElement))
      destinationRef.current = itemId ? { itemId, list: details.to } : null
      onDrop(
        projectBoardDrop({
          source: active(details.key),
          target: before ? active(before) : { id: details.to },
        })
      )
      if (followsFocus && itemId) {
        // React replaces the card across columns. Follow its interactive target,
        // while SDK keepFocus leaves a user's intervening focus change alone.
        keepFocus(
          () =>
            containers
              .get(details.to)
              ?.querySelector<HTMLElement>(`[data-board-transfer-item="${CSS.escape(itemId)}"]`) ??
            undefined
        )
      }
      return true
    },
  })
  const ownerWindow = items.values().next().value?.node.ownerDocument.defaultView
  useDOMEvent<globalThis.PointerEvent>(
    ownerWindow ?? null,
    'pointerup',
    event => {
      if (handle.instance.get().moving?.pointer) release.current = event
    },
    { capture: true }
  )
  return usePart(
    handle,
    'root',
    {},
    {
      render: (_props, state) => (
        <TransferContext.Provider
          value={{
            handle,
            moving: state.moving,
            items,
            registerItem,
            registerList,
          }}
        >
          {children}
        </TransferContext.Provider>
      ),
    }
  )
}
