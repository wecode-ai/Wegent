import {
  Field as UiField,
  FieldLabel as UiFieldLabel,
  FieldDescription as UiFieldDescription,
  FieldError as UiFieldError,
} from '@ui-sdk/react/field'
import type { ComponentProps } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

export function Field({ className, ...props }: ComponentProps<typeof UiField>) {
  return (
    <UiField
      {...props}
      className={state =>
        cn(
          'flex min-w-0 flex-col gap-1.5',
          typeof className === 'function' ? className(state) : className
        )
      }
    />
  )
}
export function FieldLabel({ className, ...props }: ComponentProps<typeof UiFieldLabel>) {
  return (
    <UiFieldLabel
      {...props}
      className={state =>
        cn(
          'text-sm font-medium text-text-primary',
          typeof className === 'function' ? className(state) : className
        )
      }
    />
  )
}
export function FieldDescription({
  className,
  ...props
}: ComponentProps<typeof UiFieldDescription>) {
  return (
    <UiFieldDescription
      {...props}
      className={state =>
        cn(
          'text-sm text-text-secondary',
          typeof className === 'function' ? className(state) : className
        )
      }
    />
  )
}
export function FieldError({ className, ...props }: ComponentProps<typeof UiFieldError>) {
  return (
    <UiFieldError
      {...props}
      className={state =>
        cn(
          'text-sm text-destructive',
          typeof className === 'function' ? className(state) : className
        )
      }
    />
  )
}
