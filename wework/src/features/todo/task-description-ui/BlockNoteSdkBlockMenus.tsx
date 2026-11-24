import { useBlockNoteSdkPopupRef } from './blockNoteSdkPopupPresence'
import { FilePanelExtension, SideMenuExtension } from '@blocknote/core/extensions'
import {
  FilePanel,
  SideMenu,
  useBlockNoteEditor,
  useExtension,
  useExtensionState,
} from '@blocknote/react'
import { Popover, PopoverContent } from '@wegent/collaboration/controls/Popover'

export function BlockNoteSdkSideMenu() {
  const editor = useBlockNoteEditor()
  const extension = useExtension(SideMenuExtension)
  const state = useExtensionState(SideMenuExtension)
  const anchor = state?.block
    ? editor.domElement?.querySelector<HTMLElement>(`[data-id="${CSS.escape(state.block.id)}"]`)
    : null
  const popupRef = useBlockNoteSdkPopupRef()
  return (
    <Popover
      open={Boolean(state?.show && anchor)}
      onOpenChange={open => {
        if (!open) extension.hideMenuIfNotFrozen()
      }}
    >
      <PopoverContent
        ref={popupRef}
        container={editor.portalElement}
        anchor={anchor}
        side="left"
        align="start"
        initialFocus="none"
        finalFocus="none"
        className="w-max p-0.5"
        data-testid="task-description-side-menu"
        aria-label={editor.dictionary.side_menu.add_block_label}
      >
        <SideMenu />
      </PopoverContent>
    </Popover>
  )
}

export function BlockNoteSdkFilePanel() {
  const editor = useBlockNoteEditor()
  const extension = useExtension(FilePanelExtension)
  const blockId = useExtensionState(FilePanelExtension)
  const anchor = blockId
    ? editor.domElement?.querySelector<HTMLElement>(`[data-id="${CSS.escape(blockId)}"]`)
    : null
  const popupRef = useBlockNoteSdkPopupRef()
  return (
    <Popover
      open={Boolean(blockId && anchor)}
      onOpenChange={open => {
        if (!open) extension.closeMenu()
      }}
    >
      <PopoverContent
        ref={popupRef}
        container={editor.portalElement}
        anchor={anchor}
        side="bottom"
        sideOffset={10}
        finalFocus={() => editor.domElement ?? null}
        className="w-max p-2"
        data-testid="task-description-file-panel"
        aria-label={editor.dictionary.file_panel.embed.title}
      >
        {blockId && <FilePanel blockId={blockId} />}
      </PopoverContent>
    </Popover>
  )
}
