import { LoaderCircle, type LucideIcon } from 'lucide-react'
import type { ComponentPropsWithoutRef } from 'react'
import { cn } from '@/lib/utils'

interface CompositedSpinnerProps extends Omit<ComponentPropsWithoutRef<'span'>, 'children'> {
  icon?: LucideIcon
  iconClassName?: string
  strokeWidth?: number
}

export function CompositedSpinner({
  icon: Icon = LoaderCircle,
  className,
  iconClassName,
  strokeWidth,
  'aria-hidden': ariaHidden = true,
  ...props
}: CompositedSpinnerProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 animate-spin items-center justify-center will-change-transform motion-reduce:animate-none',
        className
      )}
      aria-hidden={ariaHidden}
      {...props}
    >
      <Icon
        className={cn('h-full w-full', iconClassName)}
        strokeWidth={strokeWidth}
        aria-hidden="true"
      />
    </span>
  )
}
