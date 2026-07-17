import type { ReactNode } from 'react'
import { useExperimentalFeaturesEnabled } from './useExperimentalFeaturesEnabled'

export function ExperimentalFeature({ children }: { children: ReactNode }) {
  return useExperimentalFeaturesEnabled() ? children : null
}
