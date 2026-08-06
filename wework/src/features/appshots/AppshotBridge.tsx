import { useEffect } from 'react'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { subscribeToAppshots } from '@/tauri/appshots'
import { disposeTauriListener } from '@/tauri/disposeTauriListener'
import { track } from '@/telemetry/client'

function attachmentCountBucket(count: number): '1' | '2-5' | '6+' {
  if (count === 1) return '1'
  if (count <= 5) return '2-5'
  return '6+'
}

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
      if (attachments.length > 0) {
        track('appshot_received', {
          attachment_count: attachmentCountBucket(attachments.length),
        })
      }
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
