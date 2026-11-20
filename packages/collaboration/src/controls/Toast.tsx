import { Toast as UiToast } from '@ui-sdk/react/toast'
import type { ComponentProps } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

export {
  ToastRegion,
  ToastTitle,
  ToastDescription,
  ToastAction,
  ToastClose,
} from '@ui-sdk/react/toast'

export function Toast({ className, ...props }: ComponentProps<typeof UiToast>) {
  return (
    <UiToast
      {...props}
      className={state =>
        cn(
          'flex items-center gap-3 break-words rounded-lg border border-border bg-surface px-4 py-3 text-sm text-text-primary shadow-lg data-[type=error]:border-destructive/30 data-[type=error]:text-destructive',
          typeof className === 'function' ? className(state) : className
        )
      }
    />
  )
}
