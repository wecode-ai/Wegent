import { useState } from 'react'
import { Loader2 } from 'lucide-react'

interface AppIframeProps {
  src: string
  title: string
}

export function AppIframe({ src, title }: AppIframeProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  return (
    <div className="relative m-2 mt-0 h-[calc(100%-0.5rem)] overflow-hidden rounded-xl border border-border/60 bg-background shadow-[0_3px_16px_rgba(0,0,0,0.04)]">
      {loading && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <span className="text-sm text-text-secondary">Loading {title}...</span>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface">
          <span className="text-sm text-text-secondary">Failed to load {title}</span>
          <button
            type="button"
            onClick={() => { setError(false); setLoading(true) }}
            className="text-sm text-primary hover:underline"
          >
            Retry
          </button>
        </div>
      )}
      <iframe
        src={src}
        title={title}
        className="w-full h-full border-none"
        onLoad={() => setLoading(false)}
        onError={() => setError(true)}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        data-testid={`app-iframe-${title.toLowerCase()}`}
      />
    </div>
  )
}
