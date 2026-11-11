import { useLayoutEffect, useRef, useState } from 'react'
import { harnessAppsApi } from '@/api/local/harnessApps'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { getSmartAppErrorMessage } from '@/lib/smart-app-error-message'
import {
  embeddedBrowserOverlayMutationAffectsVisibility,
  hasEmbeddedBrowserOverlayConflict,
} from '@/lib/embedded-browser-overlay'

interface Props {
  installationId: string
  title: string
  active: boolean
  workspaceTabId: string
}

/** Only positions the Host-owned page; mounting a tab never creates another renderer. */
export function WorkbenchTabSurface({ installationId, title, active, workspaceTabId }: Props) {
  const { t } = useTranslation('common')
  const placeholder = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const operations = useRef<Promise<void>>(Promise.resolve())

  useLayoutEffect(() => {
    const element = placeholder.current
    if (!element) return
    let disposed = false
    let request = 0
    const layout = () => {
      const rect = element.getBoundingClientRect()
      const currentRequest = ++request
      const operation = operations.current.then(() =>
        harnessAppsApi.layout(
          installationId,
          { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          active && rect.width > 0 && rect.height > 0 && !hasEmbeddedBrowserOverlayConflict(element)
        )
      )
      operations.current = operation.catch(() => undefined)
      void operation
        .then(() => {
          if (!disposed && request === currentRequest) setError(null)
        })
        .catch(value => {
          if (!disposed && request === currentRequest)
            setError(
              getSmartAppErrorMessage(
                value,
                t('workbench.workbench_layout_failed', '无法显示工作台，请重试。'),
                t
              )
            )
        })
    }
    layout()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(layout) : null
    observer?.observe(element)
    const overlays = new MutationObserver(mutations => {
      if (embeddedBrowserOverlayMutationAffectsVisibility(mutations)) layout()
    })
    overlays.observe(document.body, {
      attributes: true,
      attributeFilter: [
        'aria-hidden',
        'aria-modal',
        'class',
        'data-embedded-browser-occlusion',
        'hidden',
        'role',
        'style',
      ],
      childList: true,
      subtree: true,
    })
    window.addEventListener('resize', layout)
    window.addEventListener('scroll', layout, true)
    return () => {
      disposed = true
      observer?.disconnect()
      overlays.disconnect()
      window.removeEventListener('resize', layout)
      window.removeEventListener('scroll', layout, true)
      operations.current = operations.current
        .then(() =>
          harnessAppsApi.layout(installationId, { x: 0, y: 0, width: 0, height: 0 }, false)
        )
        .catch(value => console.warn('[Wework] Failed to detach workbench tab', value))
    }
  }, [active, attempt, installationId, t])

  return (
    <div
      ref={placeholder}
      role="region"
      aria-label={title}
      data-testid={`app-iframe-harness-${installationId}`}
      data-workspace-tab-id={workspaceTabId}
      className="absolute inset-0 bg-background"
    >
      {error ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
          <Button
            data-testid="workbench-layout-retry"
            variant="outline"
            onClick={() => setAttempt(value => value + 1)}
          >
            {t('common.retry', '重试')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
