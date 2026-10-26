import { useDraggable, useDroppable } from '@dnd-kit/core'
import { useCallback, useContext } from 'react'
import { CSS } from '@dnd-kit/utilities'
import { ProjectBoardCardContext } from '../project-board/projectBoardCardContext'

export function useIssueBoardCardDrag(id: string, enabled: boolean) {
  const column = useContext(ProjectBoardCardContext)
  const cardId = JSON.stringify([column?.groupBy, column?.columnKey, id])
  const data = { ...column, itemId: id }
  const drag = useDraggable({ id: cardId, data, disabled: !enabled })
  const drop = useDroppable({ id: `todo-card:${cardId}`, data, disabled: !enabled })
  const setDraggableRef = drag.setNodeRef
  const setDroppableRef = drop.setNodeRef
  const setNodeRef = useCallback(
    (node: HTMLElement | null) => {
      setDraggableRef(node)
      setDroppableRef(node)
    },
    [setDraggableRef, setDroppableRef]
  )
  return {
    setNodeRef,
    style: { transform: CSS.Translate.toString(drag.transform) },
    buttonProps: enabled ? { ...drag.listeners, ...drag.attributes } : {},
    dragging: enabled && drag.isDragging,
    boardDragging: Boolean(drag.active),
    dropTarget: enabled && drop.isOver,
  }
}
