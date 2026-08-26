// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Check } from 'lucide-react'

import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'

import { formatRelativeTime } from '../utils/formatRelativeTime'
import type { StoryboardVideoVersion } from './types'

interface StoryboardVersionSelectorProps {
  currentVersion: StoryboardVideoVersion | null
  versions: StoryboardVideoVersion[]
  onChange: (clipId: number) => void
}

function getVersionTimestamp(version: StoryboardVideoVersion | null) {
  if (!version) return ''

  return version.create_time || version.created_at || version.createTime || ''
}

export function StoryboardVersionSelector({
  currentVersion,
  versions,
  onChange,
}: StoryboardVersionSelectorProps) {
  if (versions.length <= 1) {
    return null
  }

  const sortedVersions = [...versions].sort((a, b) => (b.version_no ?? 0) - (a.version_no ?? 0))

  return (
    <Select
      value={currentVersion?.id?.toString() ?? ''}
      onValueChange={value => onChange(Number(value))}
    >
      <SelectTrigger
        aria-label="分镜视频版本"
        className="h-[22px] w-auto min-w-[97px] gap-[4px] rounded-none border-0 bg-transparent p-0 text-[14px] leading-[22px] text-[#636363] focus:ring-0 focus:ring-offset-0 [&>svg]:h-[14px] [&>svg]:w-[14px] [&>svg]:text-[#939393]"
        style={{ fontFamily: "'PingFang TC', sans-serif" }}
      >
        {currentVersion ? (
          <span className="flex items-center">
            <span className="text-[14px] text-[#636363]">历史V{currentVersion.version_no}</span>
            {getVersionTimestamp(currentVersion) && (
              <span className="ml-1 text-[14px] text-[#939393]">
                {formatRelativeTime(getVersionTimestamp(currentVersion))}
              </span>
            )}
          </span>
        ) : (
          <span>选择版本</span>
        )}
      </SelectTrigger>
      <SelectContent
        align="end"
        className="z-[2147483641] w-[200px] rounded-[6px] border-0 bg-white p-[8px_4px] shadow-[0_4px_17.5px_rgba(123,123,123,0.25)]"
      >
        {sortedVersions.map(version => {
          const isSelected = version.id === currentVersion?.id

          return (
            <SelectItem
              key={version.id}
              value={version.id.toString()}
              className={`relative h-auto min-h-[38px] px-[10px] py-[9px] text-[14px] text-[#333333] rounded-[6px] ${isSelected ? 'bg-[#F5F5F5]' : ''} data-[highlighted]:bg-[#F5F5F5] [&>span:first-child]:hidden`}
              style={{ fontFamily: "'PingFang SC', sans-serif" }}
            >
              <span className="flex flex-col justify-center pr-6">
                <span>历史V{version.version_no}</span>
                <span className="text-[12px] text-[#939393]">
                  {formatRelativeTime(getVersionTimestamp(version))}
                </span>
              </span>
              {isSelected && (
                <span className="absolute right-[10px] top-1/2 flex h-[14px] w-[14px] -translate-y-1/2 items-center justify-center">
                  <Check className="h-[14px] w-[14px] text-[#333333]" strokeWidth={2} />
                </span>
              )}
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}
