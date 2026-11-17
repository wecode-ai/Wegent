import type { ReactNode } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  observationFallback,
  observationLabelKey,
  type ResourceObservation,
} from '@/features/workbench/resourceObservation'

export function ResourceObservationStatus({
  observation,
  children,
}: {
  observation: ResourceObservation
  children?: ReactNode
}) {
  const { t } = useTranslation('common')
  const current = observation.state === 'observing'
  return (
    <span className="text-xs text-text-secondary" data-testid="resource-observation-status">
      {current && children
        ? children
        : t(observationLabelKey(observation), observationFallback[observation.state])}
    </span>
  )
}
