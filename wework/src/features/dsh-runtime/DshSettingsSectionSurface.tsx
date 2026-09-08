import { DshContributionSlotSurface } from './DshContributionSlotSurface'
import { WEWORK_DSH_SLOTS, type WeworkDshSlotEntry } from './dshUiSlots'
import { useDshSlotEntries } from './useDshSlotEntries'

interface WeworkDshSettingsSection extends WeworkDshSlotEntry {
  page: string
}

export function DshSettingsSectionSurface({ page }: { page: string }) {
  const sections = useDshSlotEntries<WeworkDshSettingsSection>(WEWORK_DSH_SLOTS.settingsSection)

  return sections
    .filter(section => section.page === page)
    .map(section => (
      <DshContributionSlotSurface
        key={section.id}
        entryId={section.id}
        slot={WEWORK_DSH_SLOTS.settingsSection}
      />
    ))
}
