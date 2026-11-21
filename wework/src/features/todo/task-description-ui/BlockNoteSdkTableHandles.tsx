import { useBlockNoteSdkPopupRef } from './blockNoteSdkPopupPresence'
import { getNodeById } from '@blocknote/core'
import { TableHandlesExtension } from '@blocknote/core/extensions'
import {
  ExtendButton,
  TableCellButton,
  TableHandle,
  useBlockNoteEditor,
  useExtension,
  useExtensionState,
} from '@blocknote/react'
import { Popover, PopoverContent } from '@wegent/collaboration/controls/Popover'
import { useState } from 'react'

export function BlockNoteSdkTableHandles() {
  const editor = useBlockNoteEditor()
  const extension = useExtension(TableHandlesExtension)
  const state = useExtensionState(TableHandlesExtension)
  const [only, setOnly] = useState<string>()
  const rowPopup = useBlockNoteSdkPopupRef()
  const columnPopup = useBlockNoteSdkPopupRef()
  const cellPopup = useBlockNoteSdkPopupRef()
  if (!state) return null
  const node = getNodeById(state.block.id, editor.prosemirrorState.doc)
  if (!node) return null
  const tablePos = node.posBeforeNode + 1
  const table = editor.prosemirrorView.domAtPos(tablePos + 1).node
  if (!(table instanceof Element)) return null
  let cell: Element | undefined
  if (state.rowIndex !== undefined && state.colIndex !== undefined) {
    const rowPos = editor.prosemirrorState.doc.resolve(tablePos + 1).posAtIndex(state.rowIndex)
    const cellPos = editor.prosemirrorState.doc.resolve(rowPos + 1).posAtIndex(state.colIndex)
    const element = editor.prosemirrorView.domAtPos(cellPos + 1).node
    if (element instanceof Element) cell = element
  }
  const row = {
    contextElement: table,
    getBoundingClientRect: () => {
      const tableRect = table.getBoundingClientRect()
      const rect = cell?.getBoundingClientRect() ?? tableRect
      return new DOMRect(
        tableRect.x,
        state.draggingState?.draggedCellOrientation === 'row'
          ? state.draggingState.mousePos - rect.height / 2
          : rect.y,
        tableRect.width,
        rect.height
      )
    },
  }
  const column = {
    contextElement: table,
    getBoundingClientRect: () => {
      const tableRect = table.getBoundingClientRect()
      const rect = cell?.getBoundingClientRect() ?? tableRect
      return new DOMRect(
        state.draggingState?.draggedCellOrientation === 'col'
          ? state.draggingState.mousePos - rect.width / 2
          : rect.x,
        tableRect.y,
        rect.width,
        tableRect.height
      )
    },
  }
  const hide = (key: string) => (hidden: boolean) => setOnly(hidden ? key : undefined)
  const visible = (key: string, eligible: boolean) =>
    Boolean(state.show && eligible && (!only || only === key))
  const onOpenChange = (open: boolean) => {
    if (!open) extension.hideHandlesIfNotFrozen()
  }
  return (
    <>
      <Popover open={visible('row', state.rowIndex !== undefined)} onOpenChange={onOpenChange}>
        <PopoverContent
          container={editor.portalElement}
          ref={rowPopup}
          anchor={row}
          side="left"
          sideOffset={-10}
          initialFocus="none"
          finalFocus="none"
          className="w-max p-0"
          data-testid="task-description-table-row"
        >
          <TableHandle orientation="row" hideOtherElements={hide('row')} />
        </PopoverContent>
      </Popover>
      <Popover open={visible('column', state.colIndex !== undefined)} onOpenChange={onOpenChange}>
        <PopoverContent
          container={editor.portalElement}
          ref={columnPopup}
          anchor={column}
          side="top"
          sideOffset={-12}
          initialFocus="none"
          finalFocus="none"
          className="w-max p-0"
          data-testid="task-description-table-column"
        >
          <TableHandle orientation="column" hideOtherElements={hide('column')} />
        </PopoverContent>
      </Popover>
      <Popover open={visible('cell', Boolean(cell))} onOpenChange={onOpenChange}>
        <PopoverContent
          container={editor.portalElement}
          ref={cellPopup}
          anchor={cell}
          side="top"
          align="end"
          sideOffset={-15}
          alignOffset={-1}
          initialFocus="none"
          finalFocus="none"
          className="w-max p-0"
          data-testid="task-description-table-cell"
        >
          <TableCellButton hideOtherElements={hide('cell')} />
        </PopoverContent>
      </Popover>
      <Popover open={visible('rows', state.showAddOrRemoveRowsButton)} onOpenChange={onOpenChange}>
        <PopoverContent
          container={editor.portalElement}
          anchor={table}
          side="bottom"
          initialFocus="none"
          finalFocus="none"
          className="w-[var(--anchor-width)] p-0 [&>button]:w-full"
          data-testid="task-description-table-extend-rows"
        >
          <ExtendButton orientation="addOrRemoveRows" hideOtherElements={hide('rows')} />
        </PopoverContent>
      </Popover>
      <Popover
        open={visible('columns', state.showAddOrRemoveColumnsButton)}
        onOpenChange={onOpenChange}
      >
        <PopoverContent
          container={editor.portalElement}
          anchor={table}
          side="right"
          initialFocus="none"
          finalFocus="none"
          className="h-[var(--anchor-height)] w-max p-0 [&>button]:h-full"
          data-testid="task-description-table-extend-columns"
        >
          <ExtendButton orientation="addOrRemoveColumns" hideOtherElements={hide('columns')} />
        </PopoverContent>
      </Popover>
    </>
  )
}
