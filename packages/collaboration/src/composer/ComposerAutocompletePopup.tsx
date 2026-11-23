import type { ReactNode, RefObject } from 'react'
import { Popover, PopoverContent } from '../controls/Popover'

export function ComposerAutocompletePopup({
  anchor,
  editorRef,
  label,
  className,
  onClose,
  children,
}: {
  anchor: HTMLElement | null
  editorRef: RefObject<HTMLElement | null>
  label: string
  className: string
  onClose(restoreEditor: boolean): void
  children: ReactNode
}) {
  return (
    <Popover
      open
      onOpenChange={(open, details) => {
        if (open) return
        const target = details.event?.target
        if (
          details.reason !== 'escape-key' &&
          target instanceof Node &&
          editorRef.current?.contains(target)
        ) {
          details.cancel()
          return
        }
        onClose(details.reason === 'escape-key')
      }}
    >
      <PopoverContent
        anchor={anchor}
        side="top"
        align="start"
        sideOffset={8}
        initialFocus="none"
        finalFocus="none"
        aria-label={label}
        data-testid="composer-autocomplete-popup"
        data-embedded-browser-occlusion
        className={className}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}
