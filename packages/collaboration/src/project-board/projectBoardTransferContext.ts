import {
  createContext,
  useContext,
  useCallback,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import type { PrimitiveHandle } from '@ui-sdk/react/primitive'
import type { TransferDraft } from '@ui-sdk/core'
import { boardTransferPrimitive } from './boardTransferPrimitive'
import type { ProjectBoardDragMetadata } from './projectBoardDnd'

export interface Item {
  node: HTMLElement
  data: ProjectBoardDragMetadata
}
interface Context {
  handle: PrimitiveHandle<typeof boardTransferPrimitive>
  moving: TransferDraft | null
  items: ReadonlyMap<string, Item>
  registerItem(key: string, item: Item): () => void
  registerList(key: string, node: HTMLElement): () => void
}
export const TransferContext = createContext<Context | null>(null)

export function useProjectBoardDropTarget({ id }: { id: string }) {
  const context = useContext(TransferContext)
  const register = context?.registerList
  const transfer = context?.handle.api.transfer
  const setElement = useCallback(
    (node: HTMLElement | null) => {
      if (!node || !register || !transfer) return
      const unregister = register(id, node)
      const unbind = transfer.bindList(node, id)
      return () => {
        unbind()
        unregister()
      }
    },
    [id, register, transfer]
  )
  return {
    setElement,
    isOver: Boolean(context?.moving?.lists[id]?.includes(context.moving.key)),
  }
}

export function useProjectBoardCardTransfer(
  key: string,
  data: ProjectBoardDragMetadata,
  enabled: boolean
) {
  const context = useContext(TransferContext)
  const register = context?.registerItem
  const transfer = context?.handle.api.transfer
  const recovery = context?.handle.api.recovery
  const prepareMove = context?.handle.api.prepareMove
  const setElement = useCallback(
    (node: HTMLElement | null) => {
      if (!node || !register || !transfer || !enabled) return
      const unregister = register(key, { node, data })
      const unbind = transfer.bindItem(node, key)
      const focusTarget = node.matches('[data-board-transfer-item]')
        ? node
        : node.querySelector<HTMLElement>('[data-board-transfer-item]')
      const recover = focusTarget
        ? recovery?.bind(focusTarget, {
            key,
            props: { itemId: data.itemId ?? key },
          })
        : undefined
      return () => {
        recover?.()
        unbind()
        unregister()
      }
    },
    [data, enabled, key, register, transfer, recovery]
  )
  const moving = context?.moving
  const targetList = moving && Object.values(moving.lists).find(list => list.includes(moving.key))
  const afterMoving =
    targetList && moving ? targetList[targetList.indexOf(moving.key) + 1] : undefined
  return {
    setElement,
    style: {},
    buttonProps:
      enabled && transfer
        ? {
            onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
              prepareMove?.()
              transfer.pointerdown(event.nativeEvent, key)
            },
            onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
              if (event.key === 'Enter' && !moving) return
              if (event.key === ' ') prepareMove?.()
              transfer.keydown(event.nativeEvent, key)
            },
            'aria-pressed': moving?.key === key,
            'data-board-transfer-item': data.itemId,
          }
        : {},
    dragging: Boolean(enabled && moving?.key === key && moving.pointer),
    boardDragging: Boolean(moving),
    dropTarget: Boolean(enabled && moving?.key !== key && afterMoving === key),
  }
}
