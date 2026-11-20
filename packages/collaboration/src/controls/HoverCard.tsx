import { HoverCardContent as UiHoverCardContent } from '@ui-sdk/react/hover-card'
import type { ComponentProps } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { useCollaborationPortalTheme } from '../theme'
import { controlPopupLayout, controlPopupSurface } from './recipes'

export type {
  HoverCardApi,
  HoverCardArrowState,
  HoverCardContentProps,
  HoverCardContentState,
  HoverCardController,
  HoverCardOpenChangeReason,
  HoverCardOptions,
  HoverCardPayloadChangeReason,
  HoverCardPrimitive,
  HoverCardTriggerProps,
  HoverCardTriggerState,
} from '@ui-sdk/react/hover-card'
export {
  HoverCard,
  HoverCardArrow,
  type HoverCardProps,
  HoverCardTrigger,
} from '@ui-sdk/react/hover-card'

export function HoverCardContent<Payload = unknown>({
  className,
  style,
  sideOffset = 8,
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof UiHoverCardContent<Payload>>) {
  const theme = useCollaborationPortalTheme()
  return (
    <UiHoverCardContent<Payload>
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
