import { useTranslation } from '@/hooks/useTranslation'
import { getTelemetryConfig } from './config'

export function TelemetryCollectionNotice() {
  const { t } = useTranslation('common')
  const config = getTelemetryConfig()
  const fields = [
    ...new Set([
      ...(config.identity === 'email_prefix' ? ['email_prefix'] : []),
      ...config.contextFields,
    ]),
  ]
  if (fields.length === 0) return null
  return (
    <p data-testid="telemetry-collection-notice" className="mt-2 text-xs text-text-secondary">
      {t('workbench.telemetry_collection_notice', {
        fields: fields.map(field => t(`workbench.telemetry_field_${field}`)).join(', '),
      })}
    </p>
  )
}
