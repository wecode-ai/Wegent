import { useBlockNoteSdkPopupRef } from './blockNoteSdkPopupPresence'
import { FormattingToolbarExtension } from '@blocknote/core/extensions'
import {
  FormattingToolbar,
  useBlockNoteEditor,
  useEditorSelectionBoundingBox,
  useExtension,
  useExtensionState,
  type ComponentProps,
} from '@blocknote/react'
import { Popover, PopoverContent } from '@wegent/collaboration/controls/Popover'
import { SelectField } from '@wegent/collaboration/controls/SelectField'
import { Tooltip } from '@wegent/collaboration/controls/Tooltip'
import { Button } from '@wegent/collaboration/markdown/Button'
import { cn } from '@/lib/utils'
import { forwardRef, useMemo } from 'react'

export function ToolbarRoot({
  className,
  children,
  onMouseEnter,
  onMouseLeave,
}: ComponentProps['FormattingToolbar']['Root']) {
  return (
    <div
      className={cn('flex flex-wrap items-center gap-1', className)}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </div>
  )
}

export const ToolbarButton = forwardRef<
  HTMLButtonElement,
  ComponentProps['FormattingToolbar']['Button']
>(function ToolbarButton(
  {
    className,
    children,
    mainTooltip,
    secondaryTooltip,
    icon,
    isSelected,
    isDisabled,
    onClick,
    label,
    variant,
    ...props
  },
  ref
) {
  const button = (
    <Button
      {...props}
      ref={ref}
      variant="ghost"
      size={children ? 'sm' : 'icon'}
      disabled={isDisabled}
      onClick={onClick}
      aria-label={label ?? mainTooltip}
      data-test={
        mainTooltip
          ? mainTooltip.slice(0, 1).toLowerCase() + mainTooltip.replace(/\s+/g, '').slice(1)
          : undefined
      }
      aria-pressed={isSelected}
      data-selected={isSelected || undefined}
      data-testid={`task-description-format-${label ?? mainTooltip ?? 'action'}`}
      className={cn('data-[selected]:bg-muted', variant === 'compact' && 'md:min-h-7', className)}
    >
      {children ?? icon}
    </Button>
  )
  return mainTooltip ? (
    <Tooltip
      label={[mainTooltip, secondaryTooltip].filter(Boolean).join(' · ')}
      disabled={isDisabled}
    >
      {button}
    </Tooltip>
  ) : (
    button
  )
})

export function ToolbarSelect({
  className,
  items,
  isDisabled,
}: ComponentProps['FormattingToolbar']['Select']) {
  const editor = useBlockNoteEditor()
  const selected = items.findIndex(item => item.isSelected)
  return (
    <SelectField
      testId="task-description-format-block-type"
      accessibleLabel={
        items[selected]?.text ?? items[0]?.text ?? editor.dictionary.slash_menu.paragraph.title
      }
      density="dense"
      className={className}
      disabled={isDisabled}
      value={selected < 0 ? '' : String(selected)}
      onChange={value => items[Number(value)]?.onClick()}
      options={items.map((item, index) => ({
        value: String(index),
        label: item.text,
        icon: item.icon,
        disabled: item.isDisabled,
      }))}
    />
  )
}

export function BlockNoteSdkFormattingToolbar({ ariaLabel }: { ariaLabel: string }) {
  const editor = useBlockNoteEditor()
  const extension = useExtension(FormattingToolbarExtension, { editor })
  const show = useExtensionState(FormattingToolbarExtension, { editor })
  const bounds = useEditorSelectionBoundingBox(Boolean(show), editor)
  const anchor = useMemo(
    () => ({ getBoundingClientRect: () => editor.getSelectionBoundingBox() ?? new DOMRect() }),
    [editor]
  )
  const popupRef = useBlockNoteSdkPopupRef()
  return (
    <Popover
      open={Boolean(show && bounds)}
      onOpenChange={open => {
        if (!open) extension.store.setState(false)
      }}
    >
      <PopoverContent
        ref={popupRef}
        container={editor.portalElement}
        anchor={anchor}
        side="top"
        align="start"
        sideOffset={10}
        initialFocus="none"
        finalFocus={() => editor.domElement ?? null}
        aria-label={ariaLabel}
        data-testid="task-description-formatting-toolbar"
        className="w-max max-w-[calc(100vw-1rem)] p-1"
      >
        <FormattingToolbar />
      </PopoverContent>
    </Popover>
  )
}
