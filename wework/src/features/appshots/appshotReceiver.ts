import { subscribeToAppshots } from '@/desktop/appshots'
import { disposeDesktopListener } from '@/desktop/disposeDesktopListener'
import { track } from '@/telemetry/client'
import type { Attachment } from '@/types/api'

/** The active workbench owns capture delivery to its committed attachment scope. */
export function retainAppshotReceiver(
  onOpenWework: () => void,
  addExistingAttachment: (attachment: Attachment) => void
): () => void {
  let active = true
  let unlisten: (() => void) | undefined
  void subscribeToAppshots(attachments => {
    if (!active) return
    attachments.forEach(attachment => addExistingAttachment(attachment))
    onOpenWework()
    if (attachments.length) {
      track('appshot_received', {
        attachment_count: attachments.length === 1 ? '1' : attachments.length <= 5 ? '2-5' : '6+',
      })
    }
  })
    .then(dispose => {
      if (active) unlisten = dispose
      else disposeDesktopListener(dispose, 'Appshot')
    })
    .catch(error => console.error('[Wework] Failed to initialize Appshots:', error))
  return () => {
    active = false
    if (unlisten) disposeDesktopListener(unlisten, 'Appshot')
  }
}
