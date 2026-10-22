import { useContext } from 'react'
import { createPortal } from 'react-dom'
import { LoaderCircle } from 'lucide-react'
import {
  ComposerPredictionContext,
  ComposerPredictionPendingContext,
} from './ComposerPredictionContext'

export function ComposerPredictionStatus({
  hidden,
  testId,
  onAccept,
  target,
}: {
  hidden: boolean
  testId: string
  onAccept: (text: string) => void
  target?: HTMLElement | null
}) {
  const prediction = useContext(ComposerPredictionContext)
  const pending = useContext(ComposerPredictionPendingContext)
  if (hidden || target === null) return null
  const content = pending ? (
    <div
      role="status"
      data-testid={`${testId}-prediction-pending`}
      className="pointer-events-none flex h-7 items-center gap-1.5 px-2 text-xs text-text-muted"
    >
      <LoaderCircle
        aria-hidden="true"
        className="h-3 w-3 animate-spin motion-reduce:animate-none"
      />
      {pending}
    </div>
  ) : prediction ? (
    <button
      type="button"
      data-testid={`${testId}-prediction-accept`}
      className="flex h-7 items-center gap-2 rounded-md px-2 text-xs text-text-secondary transition-colors hover:bg-muted hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring max-md:min-h-11"
      onClick={() => {
        onAccept(prediction.text)
        prediction.onAccept()
      }}
    >
      {prediction.acceptLabel}
      <kbd className="font-code text-text-muted">Tab ↹</kbd>
    </button>
  ) : null
  return target && content ? createPortal(content, target) : content
}
