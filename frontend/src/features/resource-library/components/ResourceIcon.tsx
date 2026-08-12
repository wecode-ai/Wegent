// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CSSProperties } from 'react'
import type { IconType } from 'react-icons'

import { TEAM_ICONS } from '@/features/settings/constants/team-icons'
import { cn } from '@/lib/utils'
import type { ResourceLibraryResourceType } from '../types'

interface ResourceIconProps {
  resourceType: ResourceLibraryResourceType
  name?: string | null
  icon?: string | null
  marketplaceTags?: string[] | null
  size?: 'sm' | 'md'
  className?: string
}

const RESOURCE_TYPE_ICON_IDS: Record<ResourceLibraryResourceType, string> = {
  agent: 'robot',
  skill: 'sparkles',
  model: 'brain',
  shell: 'terminal',
  retriever: 'database',
  mcp: 'api',
}

const SIZE_CLASSES = {
  sm: {
    container: 'h-10 w-10',
    icon: 'h-5 w-5',
  },
  md: {
    container: 'h-11 w-11',
    icon: 'h-5 w-5',
  },
}

const INITIAL_COLOR_PALETTE = [
  { backgroundColor: '#FFE2CC', color: '#E95400' },
  { backgroundColor: '#DCEAFF', color: '#246FD1' },
  { backgroundColor: '#E8DEFF', color: '#6742C6' },
  { backgroundColor: '#D8F3E4', color: '#16804D' },
  { backgroundColor: '#FFDDE5', color: '#C9365A' },
  { backgroundColor: '#D5F2F5', color: '#087F8C' },
] as const

function findPresetIcon(iconId: string | null | undefined): IconType | null {
  return TEAM_ICONS.find(item => item.id === iconId)?.icon || null
}

function isImageUrl(icon: string | null | undefined): icon is string {
  if (!icon) return false
  return icon.startsWith('/') || icon.startsWith('https://') || icon.startsWith('http://')
}

function getInitial(name: string | null | undefined): string | null {
  const firstCharacter = Array.from(name?.trim() || '').find(character =>
    /[\p{L}\p{N}]/u.test(character)
  )
  return firstCharacter?.toLocaleUpperCase() || null
}

function getStableColorStyle(name: string, marketplaceTags: string[]): CSSProperties {
  const seed = `${marketplaceTags[0] || ''}:${name}`
  const hash = Array.from(seed).reduce(
    (value, character) => (value * 31 + (character.codePointAt(0) || 0)) >>> 0,
    0
  )
  return INITIAL_COLOR_PALETTE[hash % INITIAL_COLOR_PALETTE.length]
}

function resolveConfiguredIcon(icon: string | null | undefined) {
  const resourceIcon = findPresetIcon(icon)
  if (resourceIcon) {
    return {
      Icon: resourceIcon,
      source: 'resource',
      iconId: icon,
    }
  }

  return null
}

export function ResourceIcon({
  resourceType,
  name,
  icon,
  marketplaceTags = [],
  size = 'md',
  className,
}: ResourceIconProps) {
  const imageUrl = isImageUrl(icon) ? icon : null
  const configuredIcon = resolveConfiguredIcon(icon)
  const initial = getInitial(name)
  const typeIconId = RESOURCE_TYPE_ICON_IDS[resourceType]
  const TypeIcon = findPresetIcon(typeIconId) as IconType
  const source = imageUrl
    ? 'image'
    : configuredIcon
      ? configuredIcon.source
      : initial
        ? 'initial'
        : 'resource-type'
  const iconId = imageUrl || configuredIcon?.iconId || initial || typeIconId
  const shapeClassName = resourceType === 'agent' ? 'rounded-full' : 'rounded-xl'
  const sizeClasses = SIZE_CLASSES[size]
  const normalizedMarketplaceTags = marketplaceTags || []
  const initialColorStyle = initial
    ? getStableColorStyle(name?.trim() || initial, normalizedMarketplaceTags)
    : null

  return (
    <span
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden border border-primary/10 bg-primary/5 text-primary',
        !configuredIcon && initial && 'border-transparent',
        shapeClassName,
        sizeClasses.container,
        className
      )}
      style={!configuredIcon && initialColorStyle ? initialColorStyle : undefined}
      data-testid="resource-icon"
      data-icon-source={source}
      data-icon-id={iconId}
    >
      {configuredIcon ? (
        <configuredIcon.Icon className={sizeClasses.icon} aria-hidden="true" />
      ) : initial ? (
        <span className="text-lg font-bold leading-none" aria-hidden="true">
          {initial}
        </span>
      ) : (
        <TypeIcon className={sizeClasses.icon} aria-hidden="true" />
      )}
      {imageUrl && (
        // Generated marketplace icons are persisted internal assets and do not use Next image optimization.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          aria-hidden="true"
          onError={event => {
            event.currentTarget.style.display = 'none'
          }}
          data-testid="resource-icon-image"
        />
      )}
    </span>
  )
}
