import { useTranslation } from '@/hooks/useTranslation'
import { ResizableHandle } from '@wegent/collaboration/controls/Resizable'

export interface PaneResizeHandleProps {
  id: string
  resetLayout: () => void
}

export function PaneResizeHandle({ id, resetLayout }: PaneResizeHandleProps) {
  const { t } = useTranslation('collaborationExp')
  return (
    <ResizableHandle
      id={`collaboration-exp-resize-${id}`}
      data-testid={`collaboration-exp-resize-${id}`}
      aria-label={t('shell.resize')}
      className="experience-pane-separator"
      onDoubleClick={resetLayout}
    />
  )
}
