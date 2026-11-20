import {
  Progress,
  ProgressIndicator,
  ProgressTrack,
} from '@ui-sdk/react/progress'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

interface ProgressBarProps {
  value: number | null
  label: string
  testId?: string
  indicatorTestId?: string
  className?: string
}

export function ProgressBar({
  value,
  label,
  testId,
  indicatorTestId,
  className,
}: ProgressBarProps) {
  return (
    <Progress
      value={value}
      aria-label={label}
      data-testid={testId}
      className={className}
    >
      <ProgressTrack className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <ProgressIndicator
          data-testid={indicatorTestId}
          className="block h-full rounded-full bg-text-primary transition-[width] data-[indeterminate]:w-1/3 data-[indeterminate]:animate-pulse motion-reduce:animate-none motion-reduce:transition-none"
        />
      </ProgressTrack>
    </Progress>
  )
}

export function ProgressRing({
  value,
  label,
  testId,
  className,
}: Omit<ProgressBarProps, 'indicatorTestId'>) {
  return (
    <Progress
      value={value}
      render={<span />}
      aria-label={label}
      data-testid={testId}
      className={cn(
        'inline-block h-4 w-4 shrink-0 rounded-full [background:conic-gradient(rgb(var(--color-text-primary))_var(--progress-value),rgb(var(--color-border))_0)] [mask-image:radial-gradient(transparent_45%,black_55%)]',
        className,
      )}
    />
  )
}
