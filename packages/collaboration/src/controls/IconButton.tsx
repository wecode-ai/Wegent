import { LoaderCircle } from 'lucide-react'
import { forwardRef, type ReactNode } from 'react'
import { Button, type ButtonProps } from '../markdown/Button'

export interface IconButtonProps extends Omit<
  ButtonProps,
  'variant' | 'size' | 'children' | 'className' | 'style' | 'color'
> {
  'aria-label': string
  children: ReactNode
  tone?: 'neutral' | 'danger'
  density?: 'default' | 'compact'
  pending?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      children,
      disabled,
      pending = false,
      tone = 'neutral',
      density = 'default',
      ...props
    },
    ref,
  ) {
    return (
      <Button
        {...props}
        ref={ref}
        variant={tone === 'danger' ? 'destructive-ghost' : 'ghost'}
        size="icon"
        className={
          density === 'compact' ? 'shrink-0 md:h-7 md:w-7' : 'shrink-0'
        }
        disabled={disabled || pending}
        aria-busy={pending || undefined}
      >
        {pending ? (
          <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
        ) : (
          children
        )}
      </Button>
    )
  },
)
