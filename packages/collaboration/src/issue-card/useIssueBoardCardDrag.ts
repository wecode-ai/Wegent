import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useCallback } from "react";
import { CSS } from "@dnd-kit/utilities";

export function useIssueBoardCardDrag(
  id: string,
  enabled: boolean,
  columnKey?: string,
) {
  const drag = useDraggable({
    id: JSON.stringify([columnKey ?? null, id]),
    data: { itemId: id },
    disabled: !enabled,
  });
  const drop = useDroppable({
    id: `todo-card:${JSON.stringify([columnKey ?? null, id])}`,
    data: { itemId: id, columnKey },
    disabled: !enabled,
  });
  const setDraggableRef = drag.setNodeRef;
  const setDroppableRef = drop.setNodeRef;
  const setNodeRef = useCallback(
    (node: HTMLElement | null) => {
      setDraggableRef(node);
      setDroppableRef(node);
    },
    [setDraggableRef, setDroppableRef],
  );
  return {
    setNodeRef,
    style: { transform: CSS.Translate.toString(drag.transform) },
    buttonProps: enabled ? { ...drag.listeners, ...drag.attributes } : {},
    dragging: enabled && drag.isDragging,
    boardDragging: Boolean(drag.active),
    dropTarget: enabled && drop.isOver,
  };
}
