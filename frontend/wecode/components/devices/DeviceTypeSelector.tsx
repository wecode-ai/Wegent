// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Device Type Selector Component
 *
 * Presents users with two options: Local Device or Cloud Device
 * Used in the device initialization flow when no devices exist.
 */

'use client'

import '@wecode/i18n'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Terminal, Cloud, Check } from 'lucide-react'

interface DeviceTypeSelectorProps {
  onSelectLocal: () => void
  onSelectCloud: () => void
  cloudEnabled?: boolean
}

export function DeviceTypeSelector({
  onSelectLocal,
  onSelectCloud,
  cloudEnabled = true,
}: DeviceTypeSelectorProps) {
  const { t } = useTranslation('devices')

  const localBenefits = t('init_flow.local_device_benefits').split('|')
  const cloudBenefits = t('init_flow.cloud_device_benefits').split('|')

  // If cloud is not enabled, show only local device setup without selection
  if (!cloudEnabled) {
    return null
  }

  return (
    <div className="flex flex-col items-center justify-center py-8">
      <div className="w-full max-w-5xl">
        {/* Header */}
        <div className="text-center mb-8">
          <h2 className="text-xl font-semibold text-text-primary mb-2">
            {t('init_flow.select_type_title')}
          </h2>
          <p className="text-sm text-text-muted">{t('init_flow.select_type_description')}</p>
        </div>

        {/* Cards Grid */}
        <div className="grid md:grid-cols-2 gap-6">
          {/* Cloud Device Card - Recommended, placed on the left */}
          <div className="bg-surface border border-primary rounded-xl p-6 hover:border-primary/80 transition-colors relative">
            {/* Recommended Badge */}
            <div className="absolute -top-3 left-1/2 transform -translate-x-1/2">
              <span className="px-3 py-1 text-xs font-medium bg-primary text-white rounded-full">
                {t('init_flow.recommended')}
              </span>
            </div>

            <div className="flex flex-col h-full">
              {/* Icon */}
              <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center mb-4">
                <Cloud className="w-6 h-6 text-primary" />
              </div>

              {/* Title */}
              <h3 className="text-lg font-semibold text-text-primary mb-2">
                {t('init_flow.cloud_device')}
              </h3>

              {/* Description */}
              <p className="text-sm text-text-muted mb-4">{t('init_flow.cloud_device_desc')}</p>

              {/* Benefits */}
              <div className="space-y-2 mb-6 flex-1">
                {cloudBenefits.map((benefit, index) => (
                  <div key={index} className="flex items-start gap-2">
                    <Check className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                    <span className="text-sm text-text-secondary">{benefit}</span>
                  </div>
                ))}
              </div>

              {/* Button */}
              <Button variant="primary" onClick={onSelectCloud} className="w-full">
                {t('init_flow.setup_cloud_device')}
              </Button>
            </div>
          </div>

          {/* Local Device Card */}
          <div className="bg-surface border border-border rounded-xl p-6 hover:border-gray-300 transition-colors">
            <div className="flex flex-col h-full">
              {/* Icon */}
              <div className="w-12 h-12 bg-gray-100 rounded-lg flex items-center justify-center mb-4">
                <Terminal className="w-6 h-6 text-gray-600" />
              </div>

              {/* Title */}
              <h3 className="text-lg font-semibold text-text-primary mb-2">
                {t('init_flow.local_device')}
              </h3>

              {/* Description */}
              <p className="text-sm text-text-muted mb-4">{t('init_flow.local_device_desc')}</p>

              {/* Benefits */}
              <div className="space-y-2 mb-6 flex-1">
                {localBenefits.map((benefit, index) => (
                  <div key={index} className="flex items-start gap-2">
                    <Check className="w-4 h-4 text-gray-500 shrink-0 mt-0.5" />
                    <span className="text-sm text-text-secondary">{benefit}</span>
                  </div>
                ))}
              </div>

              {/* Button */}
              <Button variant="outline" onClick={onSelectLocal} className="w-full">
                {t('init_flow.setup_local_device')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
