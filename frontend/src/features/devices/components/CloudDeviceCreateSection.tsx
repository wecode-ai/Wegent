// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Cloud device creation section - External placeholder component.
 *
 * This is a "coming soon" placeholder for the open-source version.
 * The internal implementation is located in @wecode/components/devices/CloudDeviceCreateSection.tsx
 */

'use client'

import { Cloud } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

/**
 * External placeholder component for cloud device creation.
 * Shows a "coming soon" message for the open-source version.
 */
export function CloudDeviceCreateSection() {
  const { t } = useTranslation('devices')

  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Cloud className="w-12 h-12 text-text-muted mb-4" />
      <h3 className="text-lg font-semibold mb-2">{t('cloud_coming_soon_title')}</h3>
      <p className="text-sm text-text-muted max-w-md">{t('cloud_coming_soon_description')}</p>
    </div>
  )
}
