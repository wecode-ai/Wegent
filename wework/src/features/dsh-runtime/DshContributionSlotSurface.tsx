import { createElement, Fragment, Suspense, use, type ComponentType } from 'react'

import { DshSlotSurface } from './DshSlotSurface'
import { getLoadedDshUiModule, importDshUiModule } from './dshUiModules'
import { type WeworkDshSlotEntry, type WeworkDshSlotName } from './dshUiSlots'
import { useDshSlotEntries } from './useDshSlotEntries'

interface WeworkDshContributionEntry extends WeworkDshSlotEntry {
  module?: string
}

interface DshContributionSlotSurfaceProps {
  attachedClassName?: string
  props?: object
  slot: WeworkDshSlotName
}

interface DshContributionModule {
  default: ComponentType<object>
}

function DshContributionModuleLoader({ module, props }: { module: string; props: object }) {
  const cached = getLoadedDshUiModule<DshContributionModule>(module)
  const loaded = cached ?? use(importDshUiModule<DshContributionModule>(module))
  return createElement(loaded.default, props)
}

export function DshContributionSlotSurface({
  attachedClassName,
  props = {},
  slot,
}: DshContributionSlotSurfaceProps) {
  const entries = useDshSlotEntries<WeworkDshContributionEntry>(slot)

  if (entries.length === 0) return null

  return (
    <Fragment>
      {entries.map(entry =>
        entry.module ? (
          <Suspense key={entry.id} fallback={null}>
            <DshContributionModuleLoader module={entry.module} props={props} />
          </Suspense>
        ) : (
          <DshSlotSurface
            key={entry.id}
            className={attachedClassName}
            entryId={entry.id}
            props={props}
            slot={slot}
          />
        )
      )}
    </Fragment>
  )
}
