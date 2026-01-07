// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  Wrench,
  CheckCircle,
  Settings,
  AlertCircle,
  MessageSquare,
  FileText,
  type LucideIcon,
} from 'lucide-react'

/**
 * Configuration for different step types
 */
export interface StepTypeConfig {
  icon: LucideIcon
  color: string
  bgClass: string
  borderClass: string
  hoverBorderClass: string
  iconClass: string
  titleClass: string
}

/**
 * Step type configurations with icons and colors
 */
export const STEP_TYPE_CONFIGS: Record<string, StepTypeConfig> = {
  tool_use: {
    icon: Wrench,
    color: 'blue',
    bgClass: 'bg-blue-500/5',
    borderClass: 'border-blue-500/20',
    hoverBorderClass: 'hover:border-blue-500/40',
    iconClass: 'text-blue-400',
    titleClass: 'text-blue-400',
  },
  tool_result: {
    icon: CheckCircle,
    color: 'green',
    bgClass: 'bg-green-500/5',
    borderClass: 'border-green-500/20',
    hoverBorderClass: 'hover:border-green-500/40',
    iconClass: 'text-green-400',
    titleClass: 'text-green-400',
  },
  system: {
    icon: Settings,
    color: 'purple',
    bgClass: 'bg-purple-500/5',
    borderClass: 'border-purple-500/20',
    hoverBorderClass: 'hover:border-purple-500/40',
    iconClass: 'text-purple-400',
    titleClass: 'text-purple-400',
  },
  result: {
    icon: FileText,
    color: 'indigo',
    bgClass: 'bg-indigo-500/5',
    borderClass: 'border-indigo-500/20',
    hoverBorderClass: 'hover:border-indigo-500/40',
    iconClass: 'text-indigo-400',
    titleClass: 'text-indigo-400',
  },
  error: {
    icon: AlertCircle,
    color: 'red',
    bgClass: 'bg-red-500/5',
    borderClass: 'border-red-500/20',
    hoverBorderClass: 'hover:border-red-500/40',
    iconClass: 'text-red-400',
    titleClass: 'text-red-400',
  },
  assistant: {
    icon: MessageSquare,
    color: 'blue',
    bgClass: 'bg-blue-500/5',
    borderClass: 'border-blue-500/20',
    hoverBorderClass: 'hover:border-blue-500/40',
    iconClass: 'text-blue-400',
    titleClass: 'text-blue-400',
  },
  user: {
    icon: MessageSquare,
    color: 'cyan',
    bgClass: 'bg-cyan-500/5',
    borderClass: 'border-cyan-500/20',
    hoverBorderClass: 'hover:border-cyan-500/40',
    iconClass: 'text-cyan-400',
    titleClass: 'text-cyan-400',
  },
  default: {
    icon: MessageSquare,
    color: 'gray',
    bgClass: 'bg-surface/30',
    borderClass: 'border-border/20',
    hoverBorderClass: 'hover:border-border/40',
    iconClass: 'text-text-secondary',
    titleClass: 'text-blue-400',
  },
}

/**
 * Get step type configuration based on step details
 */
export function getStepTypeConfig(
  details?: { type?: string; is_error?: boolean; error_message?: string },
  hasLegacyFields?: boolean
): StepTypeConfig {
  // Check for error first
  if (details?.is_error || details?.error_message) {
    return STEP_TYPE_CONFIGS.error
  }

  // Get config based on type
  const type = details?.type
  if (type && STEP_TYPE_CONFIGS[type]) {
    return STEP_TYPE_CONFIGS[type]
  }

  // Legacy fields fallback
  if (hasLegacyFields) {
    return STEP_TYPE_CONFIGS.default
  }

  return STEP_TYPE_CONFIGS.default
}
