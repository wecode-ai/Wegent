// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useMemo } from 'react'
import { Team } from '@/types/api'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { AdjustmentsHorizontalIcon } from '@heroicons/react/24/outline'

interface DifyParamsFormProps {
  selectedTeam: Team | null
  selectedAppId: string | null
  params: Record<string, unknown>
  onParamsChange: (params: Record<string, unknown>) => void
  disabled?: boolean
}

const STORAGE_PREFIX = 'dify_params_team_'

export default function DifyParamsForm({
  selectedTeam,
  selectedAppId: _selectedAppId,
  params,
  onParamsChange,
  disabled = false,
}: DifyParamsFormProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  // Check if selected team is using Dify runtime
  const isDifyTeam = useMemo(() => {
    if (!selectedTeam || !selectedTeam.bots || selectedTeam.bots.length === 0) {
      return false
    }
    const firstBot = selectedTeam.bots[0]
    try {
      if (firstBot.bot_prompt) {
        const promptData = JSON.parse(firstBot.bot_prompt)
        return 'difyAppId' in promptData || 'params' in promptData
      }
    } catch {
      // Not a JSON, not a Dify team
    }
    return false
  }, [selectedTeam])

  // Load params from localStorage on mount
  useEffect(() => {
    if (!selectedTeam || !isDifyTeam) return

    const storageKey = `${STORAGE_PREFIX}${selectedTeam.id}`
    const stored = localStorage.getItem(storageKey)

    if (stored) {
      try {
        const parsedParams = JSON.parse(stored)
        onParamsChange(parsedParams)
      } catch (err) {
        console.error('Failed to parse stored params:', err)
      }
    }
  }, [selectedTeam?.id, isDifyTeam]) // eslint-disable-line react-hooks/exhaustive-deps

  // Save params to localStorage when they change
  useEffect(() => {
    if (!selectedTeam || !isDifyTeam) return

    const storageKey = `${STORAGE_PREFIX}${selectedTeam.id}`
    if (Object.keys(params).length > 0) {
      localStorage.setItem(storageKey, JSON.stringify(params))
    }
  }, [params, selectedTeam, isDifyTeam])

  const handleParamChange = (key: string, value: string) => {
    onParamsChange({
      ...params,
      [key]: value,
    })
  }

  const handleJsonChange = (value: string) => {
    try {
      const parsed = JSON.parse(value)
      onParamsChange(parsed)
    } catch {
      // Invalid JSON, ignore
    }
  }

  // Don't render if not a Dify team
  if (!isDifyTeam) {
    return null
  }

  const paramsJson = JSON.stringify(params, null, 2)

  return (
    <div className="w-full">
      <Accordion type="single" collapsible value={isExpanded ? 'params' : ''}>
        <AccordionItem value="params" className="border-0">
          <AccordionTrigger
            className="py-2 hover:no-underline text-xs text-text-muted hover:text-text-secondary"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            <div className="flex items-center gap-2">
              <AdjustmentsHorizontalIcon className="w-3.5 h-3.5" />
              <span>Dify Parameters</span>
              {Object.keys(params).length > 0 && (
                <span className="ml-1 text-xs text-primary">({Object.keys(params).length})</span>
              )}
            </div>
          </AccordionTrigger>
          <AccordionContent className="pt-3 pb-2 space-y-3">
            <div className="space-y-2">
              <Label htmlFor="dify-params-json" className="text-xs text-text-secondary">
                Parameters (JSON)
              </Label>
              <Textarea
                id="dify-params-json"
                value={paramsJson}
                onChange={e => handleJsonChange(e.target.value)}
                placeholder='{"key": "value"}'
                className="text-xs font-mono min-h-[100px] max-h-[200px]"
                disabled={disabled}
              />
              <p className="text-xs text-text-muted">
                Enter parameters as JSON. Example: {'{'}
                &quot;customer_name&quot;: &quot;John&quot;, &quot;language&quot;: &quot;en-US&quot;
                {'}'}
              </p>
            </div>

            {/* Quick parameter inputs */}
            {Object.keys(params).length > 0 && (
              <div className="space-y-2 pt-2 border-t border-border">
                <Label className="text-xs text-text-secondary">Quick Edit</Label>
                <div className="space-y-2 max-h-[200px] overflow-y-auto">
                  {Object.entries(params).map(([key, value]) => (
                    <div key={key} className="flex items-center gap-2">
                      <Label className="text-xs min-w-[80px] truncate" title={key}>
                        {key}
                      </Label>
                      <Input
                        value={String(value || '')}
                        onChange={e => handleParamChange(key, e.target.value)}
                        className="text-xs flex-1"
                        disabled={disabled}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  )
}
