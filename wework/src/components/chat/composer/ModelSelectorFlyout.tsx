import * as Popover from '@radix-ui/react-popover'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import styles from './ModelSelector.module.css'

type CollisionPadding = number | Partial<Record<'top' | 'right' | 'bottom' | 'left', number>>

interface ModelSelectorFlyoutProps {
  anchor: ReactElement
  children: ReactNode
  collisionPadding: CollisionPadding
  contentClassName?: string
  contentStyle?: CSSProperties
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ModelSelectorFlyout({
  anchor,
  children,
  collisionPadding,
  contentClassName,
  contentStyle,
  open,
  onOpenChange,
}: ModelSelectorFlyoutProps) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Anchor asChild>{anchor}</Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          data-model-selector-layer="true"
          data-embedded-browser-occlusion
          data-testid="model-selector-submenu"
          data-enter-animation="submenu"
          side="right"
          align="start"
          sideOffset={4}
          alignOffset={-4}
          collisionPadding={collisionPadding}
          avoidCollisions
          onOpenAutoFocus={event => event.preventDefault()}
          onCloseAutoFocus={event => event.preventDefault()}
          style={{
            maxWidth: 'min(var(--radix-popover-content-available-width), calc(100vw - 16px))',
            maxHeight: 'min(var(--radix-popover-content-available-height), calc(100vh - 16px))',
            ...contentStyle,
          }}
          className={cn(
            'z-system-popover overflow-y-auto rounded-xl bg-popover/95 p-1 shadow-[0_8px_16px_-4px_rgba(0,0,0,0.18)] ring-1 ring-border/30 backdrop-blur-xl',
            styles.submenu,
            contentClassName
          )}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
