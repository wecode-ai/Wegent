import { useCallback, useState } from 'react'
import type { ProcessExplorerClient, ProcessSnapshot } from '@wegent/process-explorer'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { ProcessExplorerView } from '@/features/process-explorer/ProcessExplorerView'

const processExplorerClient: ProcessExplorerClient = {
  snapshot: () => invokeDesktopHost<ProcessSnapshot>('diagnostics.processSnapshot'),
}

/**
 * Binds the process explorer surface to host capabilities. Collection stays in
 * the host; labels and grouping live in the feature.
 */
export function ProcessExplorerPage() {
  const [alwaysOnTop, setAlwaysOnTop] = useState(false)

  const copyText = useCallback(async (text: string) => {
    await invokeDesktopHost('clipboard.writeText', { text })
  }, [])

  const toggleAlwaysOnTop = useCallback(async () => {
    try {
      const result = await invokeDesktopHost<{ alwaysOnTop: boolean }>(
        'processExplorer.setAlwaysOnTop',
        { alwaysOnTop: !alwaysOnTop }
      )
      setAlwaysOnTop(result.alwaysOnTop)
    } catch {
      setAlwaysOnTop(false)
    }
  }, [alwaysOnTop])

  return (
    <ProcessExplorerView
      client={processExplorerClient}
      alwaysOnTop={alwaysOnTop}
      onToggleAlwaysOnTop={() => void toggleAlwaysOnTop()}
      onCopyText={copyText}
    />
  )
}
