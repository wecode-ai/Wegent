import { forwardRef, type ComponentPropsWithoutRef } from 'react'
import { composerContextAction } from '../controls/recipes'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { Button } from '../markdown/Button'

type Props = Omit<ComponentPropsWithoutRef<typeof Button>, 'variant' | 'size'>

export const ComposerContextButton = forwardRef<HTMLButtonElement, Props>(
  function ComposerContextButton({ className, ...props }, ref) {
    return (
      <Button
        type="button"
        variant="unstyled"
        ref={ref}
        {...props}
        className={cn(composerContextAction, className)}
      />
    )
  }
)
