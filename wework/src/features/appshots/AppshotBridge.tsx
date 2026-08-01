import { useEffect } from 'react'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { subscribeToAppshots } from '@/tauri/appshots'
import { disposeTauriListener } from '@/tauri/disposeTauriListener'

interface AppshotBridgeProps {
  onOpenWework: () => void
}

export function AppshotBridge({ onOpenWework }: AppshotBridgeProps) {
  const { addExistingAttachment } = useWorkbench().projectChat

  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined

    subscribeToAppshots(attachments => {
      if (!active) return
      onOpenWework()
      attachments.forEach(attachment => addExistingAttachment(attachment))
    })
      .then(dispose => {
        if (active) {
          unlisten = dispose
        } else {
          disposeTauriListener(dispose, 'Appshot')
        }
      })
      .catch(error => {
        console.error('[Wework] Failed to initialize Appshots:', error)
      })

    return () => {
      active = false
      if (unlisten) disposeTauriListener(unlisten, 'Appshot')
    }
  }, [addExistingAttachment, onOpenWework])

  return null
}
