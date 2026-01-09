import { useTranslation as useI18nTranslation } from 'react-i18next'

/**
 * Custom useTranslation hook wrapper
 */
export function useTranslation(namespace?: string) {
  return useI18nTranslation(namespace)
}
