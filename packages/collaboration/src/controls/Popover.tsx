import { PopoverContent as UiPopoverContent } from '@ui-sdk/react/popover'
import type { ComponentProps } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { useCollaborationPortalTheme } from '../theme'
import { controlPopupLayout, controlPopupSurface } from './recipes'

export type {
  PopoverApi,
  PopoverArrowState,
  PopoverContentProps,
  PopoverContentState,
  PopoverController,
  PopoverDismissReason,
  PopoverFinalFocus,
  PopoverInitialFocus,
  PopoverOpenChangeReason,
  PopoverOptions,
  PopoverPayloadChangeReason,
  PopoverPrimitive,
  PopoverShortcutProps,
  PopoverShortcutState,
  PopoverTriggerProps,
  PopoverTriggerState,
} from '@ui-sdk/react/popover'
export {
  Popover,
  PopoverArrow,
  PopoverClose,
  PopoverDescription,
  type PopoverProps,
  PopoverShortcut,
  PopoverTitle,
  PopoverTrigger,
} from '@ui-sdk/react/popover'

export function PopoverContent<Payload = unknown>({
  className,
  style,
  sideOffset = 4,
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof UiPopoverContent<Payload>>) {
  const theme = useCollaborationPortalTheme()
  return (
    <UiPopoverContent<Payload>
      {...theme}
      {...props}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={(state) =>
        cn(
          theme.className,
          controlPopupLayout,
          typeof className === 'function' ? className(state) : className,
          controlPopupSurface,
        )
      }
      style={(state) => ({
        ...theme.style,
        ...(typeof style === 'function' ? style(state) : style),
      })}
    />
  )
}
