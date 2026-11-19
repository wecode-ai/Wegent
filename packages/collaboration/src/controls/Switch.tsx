import { SwitchThumb, Switch as UiSwitch } from '@ui-sdk/react/switch'
import type { ComponentProps } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

export function Switch({
  checked,
  className,
  ...props
}: Omit<ComponentProps<typeof UiSwitch>, 'children' | 'className'> & {
  children?: never
  className?: string
}) {
  return (
    <UiSwitch
      {...props}
      checked={checked}
      className={cn(
        'group/switch inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/40 disabled:cursor-not-allowed disabled:opacity-40 md:min-h-6 md:min-w-8',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="relative flex h-5 w-8 items-center rounded-full bg-text-muted/30 transition-colors group-data-[checked]/switch:bg-text-primary"
      >
        <SwitchThumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-background shadow-sm transition-transform group-data-[checked]/switch:translate-x-[14px]" />
      </span>
    </UiSwitch>
  )
}
