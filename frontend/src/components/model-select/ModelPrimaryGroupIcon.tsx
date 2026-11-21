// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  Brain,
  Code,
  Cpu,
  FlaskConical,
  Globe,
  Layers,
  MapPin,
  Shield,
  Sparkles,
  Zap,
} from 'lucide-react'

export const modelPrimaryGroupIconChoices = {
  globe: Globe,
  'map-pin': MapPin,
  zap: Zap,
  brain: Brain,
  code: Code,
  cpu: Cpu,
  layers: Layers,
  sparkles: Sparkles,
  shield: Shield,
  'flask-conical': FlaskConical,
}

export function ModelPrimaryGroupIcon({
  group,
  decorative,
  icon,
}: {
  group?: string | null
  decorative?: boolean
  icon?: string | null
}) {
  const name = group?.trim()
  if (!name) return null

  const Icon =
    icon && Object.hasOwn(modelPrimaryGroupIconChoices, icon)
      ? modelPrimaryGroupIconChoices[icon as keyof typeof modelPrimaryGroupIconChoices]
      : undefined

  return (
    <span
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative}
      title={name}
      className="flex shrink-0 text-text-secondary"
    >
      {Icon ? (
        <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      ) : (
        <GeneratedGroupIcon name={name} />
      )}
    </span>
  )
}

function GeneratedGroupIcon({ name }: { name: string }) {
  // Hash the configured name so the icon stays consistent when the model list changes.
  let hash = 2166136261
  for (let index = 0; index < name.length; index++) {
    hash = Math.imul(hash ^ name.charCodeAt(index), 16777619)
  }
  // Keep the center filled so every group has a visible mark.
  const cells = (hash >>> 7) | (1 << 12)

  return (
    <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 14 14" fill="currentColor">
      {Array.from({ length: 25 }, (_, index) =>
        (cells & (1 << index)) !== 0 ? (
          <rect
            key={index}
            x={(index % 5) * 3}
            y={Math.floor(index / 5) * 3}
            width="2"
            height="2"
            rx="0.4"
          />
        ) : null
      )}
    </svg>
  )
}
