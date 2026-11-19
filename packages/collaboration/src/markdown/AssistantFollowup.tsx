import { Check, Copy } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Tooltip } from "../controls/Tooltip"
import { Button as ControlButton } from './Button'
import { useMarkdownServices } from './MarkdownServices'

export function AssistantFollowup({ prompt, children }: { prompt?: string; children: ReactNode }) {
  const { copyText, translate } = useMarkdownServices()
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  if (!prompt) return <span>{children}</span>
  return (
    <Tooltip label={translate(`followup.${status}`)}>
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid="assistant-followup-copy"
        aria-label={translate(`followup.${status}`)}
        className="inline-flex items-center gap-1 rounded-md px-1 text-sm text-text-primary hover:bg-muted"
        onClick={async () => {
          try {
            await copyText(prompt)
            setStatus('copied')
          } catch {
            setStatus('failed')
          }
        }}
      >
        {children}
        {status === 'copied' ? (
          <Check aria-hidden className="h-3.5 w-3.5" />
        ) : (
          <Copy aria-hidden className="h-3.5 w-3.5" />
        )}
      </ControlButton>
      <span className="sr-only" role="status">
        {status === 'idle' ? '' : translate(`followup.${status}`)}
      </span>
    </Tooltip>
  )
}
