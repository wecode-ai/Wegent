// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useMemo, useState } from 'react'
import Image from 'next/image'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { RiRobot2Line } from 'react-icons/ri'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { TeamMode } from '../team-modes'
import { cn } from '@/lib/utils'

interface TeamModeSelectorProps {
  mode: TeamMode
  onModeChange: (mode: TeamMode) => void
  shouldCollapse?: boolean
  onCollapseHandled?: () => void
}

export default function TeamModeSelector({
  mode,
  onModeChange,
  shouldCollapse,
  onCollapseHandled,
}: TeamModeSelectorProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)

  // Handle collapse from parent (after dialog confirmation)
  React.useEffect(() => {
    if (shouldCollapse) {
      setIsExpanded(false)
      onCollapseHandled?.()
    }
  }, [shouldCollapse, onCollapseHandled])

  // Mode info with description and image
  const modeInfo = useMemo(() => {
    const imageMap: Record<TeamMode, string | null> = {
      solo: null,
      pipeline: '/settings/sequential.png',
      route: '/settings/router.png',
      coordinate: '/settings/network.png',
      collaborate: '/settings/parallel.png',
    }

    return {
      title: t(`team_model.${mode}`),
      desc: t(`team_model_desc.${mode}`),
      image: imageMap[mode],
    }
  }, [mode, t])

  return (
    <div className="space-y-2">
      {/* Title outside the collapsible container */}
      <div className="flex items-center">
        <Label className="text-sm font-medium text-text-primary">
          {t('common:team.model')} <span className="text-red-400">*</span>
        </Label>
      </div>

      <div className="rounded-md border border-border bg-base">
        {/* Collapsible header - shows current mode */}
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full flex items-center justify-between p-3 hover:bg-accent/50 transition-colors rounded-md"
        >
          <span className="text-sm font-medium text-text-primary">{t(`team_model.${mode}`)}</span>
          <ChevronDown
            className={cn(
              'h-4 w-4 text-text-secondary transition-transform duration-200',
              isExpanded && 'rotate-180'
            )}
          />
        </button>

        {/* Collapsible content */}
        <div
          className={cn(
            'overflow-hidden transition-all duration-200',
            isExpanded ? 'max-h-[500px] opacity-100' : 'max-h-0 opacity-0'
          )}
        >
          <div className="px-3 pb-3 space-y-3">
            {/* Mode selection */}
            <RadioGroup
              value={mode}
              onValueChange={value => {
                onModeChange(value as TeamMode)
              }}
              className="w-full grid grid-cols-5 gap-2"
            >
              {(['solo', 'pipeline', 'route', 'coordinate', 'collaborate'] as TeamMode[]).map(
                opt => (
                  <div key={opt} className="flex items-center">
                    <RadioGroupItem
                      value={opt}
                      id={`selector-mode-${opt}`}
                      className="peer sr-only"
                    />
                    <label
                      htmlFor={`selector-mode-${opt}`}
                      className={`
                      flex items-center justify-center w-full px-3 py-1.5 text-sm font-medium
                      rounded-md cursor-pointer transition-colors
                      border border-border
                      peer-data-[state=checked]:bg-primary peer-data-[state=checked]:text-primary-foreground peer-data-[state=checked]:border-primary
                      hover:bg-accent hover:text-accent-foreground
                    `}
                    >
                      {t(`team_model.${opt}`)}
                    </label>
                  </div>
                )
              )}
            </RadioGroup>

            {/* Divider */}
            <div className="border-t border-border"></div>

            {/* Mode description - vertical layout with larger image */}
            <div className="space-y-3">
              <p className="text-sm text-text-secondary">{modeInfo.desc}</p>
              <div className="w-full h-40 rounded-md overflow-hidden flex items-center justify-center bg-muted/30">
                {modeInfo.image ? (
                  <Image
                    src={modeInfo.image}
                    alt={modeInfo.title}
                    width={320}
                    height={160}
                    className="object-contain max-w-full max-h-full"
                  />
                ) : (
                  <RiRobot2Line className="w-20 h-20 text-primary/60" />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
