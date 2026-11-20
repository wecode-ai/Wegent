import { Button } from '@/components/ui/button'
import { DshSlotSurface } from '@/features/dsh-runtime/DshSlotSurface'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { Checkbox } from '@wegent/collaboration/controls/Checkbox'

const props = { controls: { Button, Checkbox } }

export default function TranscriptSyncSettingsSection() {
  return (
    <DshSlotSurface
      slot={WEWORK_DSH_SLOTS.settingsSection}
      entryId="wework-transcript-sync"
      props={props}
    />
  )
}
