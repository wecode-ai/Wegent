import { Button as UiButton } from '@ui-sdk/react/button'
import { cva, type VariantProps } from 'class-variance-authority'
import * as React from 'react'
import { Tooltip } from '../controls/Tooltip'
import { TooltipContext } from '../controls/tooltipContext'

import { activityClassNames as cn } from '../issue-detail/activityClassNames'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus keyboard:focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        unstyled: '',
        primary: 'bg-text-primary text-background hover:bg-text-primary/90',
        default: 'bg-text-primary text-background hover:bg-text-primary/90',
        destructive:
          'bg-destructive text-destructive-contrast hover:bg-destructive/90',
        'destructive-ghost':
          'bg-transparent text-destructive hover:bg-destructive/10',
        outline:
          'border border-border bg-background text-text-primary hover:bg-muted',
        secondary: 'bg-muted text-text-primary hover:bg-muted/80',
        ghost: 'text-text-primary hover:bg-muted',
        link: 'text-text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'min-h-11 px-4 md:min-h-9',
        sm: 'min-h-11 px-3 md:min-h-8',
        lg: 'min-h-11 px-6',
        icon: 'h-11 w-11 rounded-lg md:h-8 md:w-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  showTooltip?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, showTooltip = true, ...props }, ref) => {
    const { children, onClick, ...nativeProps } = props
    const hasTooltip = React.useContext(TooltipContext)
    const button = (
      <UiButton
        className={
          variant === 'unstyled'
            ? cn(
                'max-md:min-h-11 max-md:min-w-11 outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-40',
                className,
              )
            : cn(buttonVariants({ variant, size, className }))
        }
        ref={ref}
        {...nativeProps}
        render={
          asChild && React.isValidElement(children) ? children : undefined
        }
        onClick={(event) =>
          onClick?.(event as React.MouseEvent<HTMLButtonElement>)
        }
      >
        {asChild ? undefined : children}
      </UiButton>
    )
    return showTooltip && props['aria-label'] && !hasTooltip ? (
      <Tooltip label={props['aria-label']} disabled={props.disabled}>
        {button}
      </Tooltip>
    ) : (
      button
    )
  },
)
Button.displayName = 'Button'

export { Button, buttonVariants }
