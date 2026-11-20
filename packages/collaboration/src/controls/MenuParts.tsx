import {
  MenuContent as UiMenuContent,
  MenuSubContent as UiMenuSubContent,
  MenuItem as UiMenuItem,
  MenuCheckboxItem as UiMenuCheckboxItem,
  MenuRadioItem as UiMenuRadioItem,
  MenuSubTrigger as UiMenuSubTrigger,
  MenuGroupLabel as UiMenuGroupLabel,
  MenuSeparator as UiMenuSeparator,
} from '@ui-sdk/react/menu'
import type { ComponentProps } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { useCollaborationPortalTheme } from '../theme'
import {
  controlMenuOption,
  controlOption,
  controlPopupLayout,
  controlPopupSurface,
} from './recipes'

export type {
  MenuApi,
  MenuCheckboxItemProps,
  MenuCheckboxItemState,
  MenuActionDetails,
  MenuCheckedChangeDetails,
  MenuCheckedChangeReason,
  MenuContentProps,
  MenuContentState,
  MenuContextTriggerProps,
  MenuContextTriggerState,
  MenuController,
  MenuData,
  MenuDataItem,
  MenuDismissReason,
  MenuFinalFocus,
  MenuItemIconProps,
  MenuItemIconState,
  MenuItemIndicatorProps,
  MenuItemIndicatorState,
  MenuItemProps,
  MenuItemState,
  MenuOpenChangeReason,
  MenuOpenOptions,
  MenuOptions,
  MenuPayloadChangeReason,
  MenuPrimitive,
  MenuRadioGroupProps,
  MenuRadioGroupState,
  MenuRadioItemProps,
  MenuRadioItemState,
  MenuSubTriggerProps,
  MenuTriggerProps,
  MenuTriggerState,
  MenuValueChangeDetails,
  MenuValueChangeReason,
} from '@ui-sdk/react/menu'
export {
  Menu,
  MenuContextTrigger,
  MenuGroup,
  MenuItemIcon,
  MenuItemIndicator,
  MenuItems,
  type MenuProps,
  MenuRadioGroup,
  MenuShortcut,
  MenuSub,
  type MenuSubProps,
  MenuTrigger,
} from '@ui-sdk/react/menu'

export function MenuContent<Payload = unknown>({
  className,
  style,
  sideOffset = 4,
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof UiMenuContent<Payload>>) {
  const theme = useCollaborationPortalTheme()
  return (
    <UiMenuContent<Payload>
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

export function MenuSubContent<Payload = unknown>({
  className,
  style,
  sideOffset = 4,
  collisionPadding = 8,
  ...props
}: ComponentProps<typeof UiMenuSubContent<Payload>>) {
  const theme = useCollaborationPortalTheme()
  return (
    <UiMenuSubContent<Payload>
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

export function MenuItem({
  className,
  ...props
}: ComponentProps<typeof UiMenuItem>) {
  return (
    <UiMenuItem
      {...props}
      className={(state) =>
        cn(
          controlOption,
          typeof className === 'function' ? className(state) : className,
          controlMenuOption,
        )
      }
    />
  )
}

export function MenuCheckboxItem({
  className,
  ...props
}: ComponentProps<typeof UiMenuCheckboxItem>) {
  return (
    <UiMenuCheckboxItem
      {...props}
      className={(state) =>
        cn(
          controlOption,
          typeof className === 'function' ? className(state) : className,
          controlMenuOption,
        )
      }
    />
  )
}

export function MenuRadioItem({
  className,
  ...props
}: ComponentProps<typeof UiMenuRadioItem>) {
  return (
    <UiMenuRadioItem
      {...props}
      className={(state) =>
        cn(
          controlOption,
          typeof className === 'function' ? className(state) : className,
          controlMenuOption,
        )
      }
    />
  )
}

export function MenuSubTrigger({
  className,
  ...props
}: ComponentProps<typeof UiMenuSubTrigger>) {
  return (
    <UiMenuSubTrigger
      {...props}
      className={(state) =>
        cn(
          controlOption,
          typeof className === 'function' ? className(state) : className,
          controlMenuOption,
        )
      }
    />
  )
}

export function MenuGroupLabel({
  className,
  ...props
}: ComponentProps<typeof UiMenuGroupLabel>) {
  return (
    <UiMenuGroupLabel
      {...props}
      className={(state) =>
        cn(
          'px-2.5 pb-1 pt-1.5 text-xs font-medium text-text-secondary',
          typeof className === 'function' ? className(state) : className,
        )
      }
    />
  )
}

export function MenuSeparator({
  className,
  ...props
}: ComponentProps<typeof UiMenuSeparator>) {
  return (
    <UiMenuSeparator
      {...props}
      className={(state) =>
        cn(
          'my-1 h-px bg-border',
          typeof className === 'function' ? className(state) : className,
        )
      }
    />
  )
}
