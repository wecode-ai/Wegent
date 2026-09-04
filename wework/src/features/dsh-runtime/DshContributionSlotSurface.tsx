import { createElement, Fragment, useEffect, useState, type ComponentType } from 'react'

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
  const [loaded, setLoaded] = useState<DshContributionModule | null>(() =>
    getLoadedDshUiModule<DshContributionModule>(module)
  )
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let active = true
    void importDshUiModule<DshContributionModule>(module).then(
      value => {
        if (active) setLoaded(value)
      },
      reason => {
        if (active) setError(reason)
      }
    )
    return () => {
      active = false
    }
  }, [module])

  if (error) throw error
  if (!loaded) return null
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
          <DshContributionModuleLoader
            key={`${entry.id}:${entry.module}`}
            module={entry.module}
            props={props}
          />
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
