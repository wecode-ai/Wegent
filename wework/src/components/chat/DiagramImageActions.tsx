import { Check, Copy, Download, LoaderCircle, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { copyDiagramPng, renderDiagramPng, saveDiagramPng } from './diagramImageExport'
import { useTranslation } from '@/hooks/useTranslation'

type ActionState = 'busy' | 'error' | 'idle' | 'success'

interface DiagramImageActionsProps {
  containerRef: RefObject<HTMLElement | null>
  filename: string
  theme: 'dark' | 'light' | 'system'
}

export function DiagramImageActions({ containerRef, filename, theme }: DiagramImageActionsProps) {
  const { t } = useTranslation()
  const [copyState, setCopyState] = useState<ActionState>('idle')
  const [saveState, setSaveState] = useState<ActionState>('idle')

  const runAction = async (
    setState: (state: ActionState) => void,
    action: (blob: Blob) => Promise<boolean | void> | boolean | void
  ) => {
    const container = containerRef.current
    if (!container) return

    setState('busy')
    try {
      const blob = await renderDiagramPng(container, theme)
      const completed = await action(blob)
      if (completed === false) {
        setState('idle')
        return
      }
      setState('success')
      window.setTimeout(() => setState('idle'), 1_500)
    } catch (error) {
      console.warn('[Wework] Diagram image action failed.', error)
      setState('error')
      window.setTimeout(() => setState('idle'), 2_000)
    }
  }

  const copyLabel =
    copyState === 'success'
      ? t('workbench.diagram_image_copied', '图片已复制')
      : copyState === 'error'
        ? t('workbench.diagram_image_copy_failed', '复制图片失败')
        : t('workbench.diagram_copy_image', '复制图片')
  const saveLabel =
    saveState === 'success'
      ? t('workbench.diagram_image_saved', '图片已保存')
      : saveState === 'error'
        ? t('workbench.diagram_image_save_failed', '保存图片失败')
        : t('workbench.diagram_save_image', '保存图片')

  return (
    <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded-lg border border-border bg-background/90 p-1 shadow-sm backdrop-blur">
      <button
        type="button"
        data-testid="diagram-copy-image-button"
        aria-label={copyLabel}
        title={copyLabel}
        disabled={copyState === 'busy'}
        onClick={() => void runAction(setCopyState, copyDiagramPng)}
        className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50"
      >
        <ActionIcon state={copyState} idleIcon={<Copy className="h-4 w-4" />} />
      </button>
      <button
        type="button"
        data-testid="diagram-save-image-button"
        aria-label={saveLabel}
        title={saveLabel}
        disabled={saveState === 'busy'}
        onClick={() => void runAction(setSaveState, blob => saveDiagramPng(blob, filename))}
        className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50"
      >
        <ActionIcon state={saveState} idleIcon={<Download className="h-4 w-4" />} />
      </button>
    </div>
  )
}

function ActionIcon({ state, idleIcon }: { state: ActionState; idleIcon: ReactNode }) {
  if (state === 'busy') return <LoaderCircle className="h-4 w-4 animate-spin" />
  if (state === 'success') return <Check className="h-4 w-4 text-emerald-500" />
  if (state === 'error') return <TriangleAlert className="h-4 w-4 text-red-500" />
  return idleIcon
}
