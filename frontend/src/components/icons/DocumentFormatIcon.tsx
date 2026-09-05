// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  File,
  FileAudio,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Globe,
  Image,
  Link2,
  Presentation,
  Table2,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// Visual categories are independent of upload or import eligibility.
const FORMAT_ICONS = [
  {
    extensions: ['adoc', 'doc', 'docx', 'txt', 'md'],
    icon: FileText,
    className: 'text-blue-600 dark:text-blue-400',
  },
  { extensions: ['pdf'], icon: FileText, className: 'text-error' },
  { extensions: ['dlink'], icon: Link2, className: 'text-blue-600 dark:text-blue-400' },
  { extensions: ['able'], icon: Table2, className: 'text-primary' },
  {
    extensions: ['axls', 'xls', 'xlsx', 'csv'],
    icon: FileSpreadsheet,
    className: 'text-green-600 dark:text-green-400',
  },
  {
    extensions: ['appt', 'ppt', 'pptx'],
    icon: Presentation,
    className: 'text-orange-600 dark:text-orange-400',
  },
  {
    extensions: ['htm', 'html', 'html5'],
    icon: Globe,
    className: 'text-blue-600 dark:text-blue-400',
  },
  {
    extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff'],
    icon: Image,
    className: 'text-purple-600 dark:text-purple-400',
  },
  {
    extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'],
    icon: FileAudio,
    className: 'text-orange-600 dark:text-orange-400',
  },
  {
    extensions: ['mp4', 'avi', 'mkv', 'mov', 'flv', 'wmv', 'webm', 'm4v'],
    icon: FileVideo,
    className: 'text-purple-600 dark:text-purple-400',
  },
]

export function DocumentFormatIcon({
  extension,
  sourceType,
  className,
}: {
  extension?: string | null
  sourceType?: string | null
  className?: string
}) {
  const format = extension?.trim().toLowerCase().replace(/^\.+/, '') ?? ''
  const visual =
    sourceType === 'web'
      ? { icon: Globe, className: 'text-blue-600 dark:text-blue-400' }
      : FORMAT_ICONS.find(category => category.extensions.includes(format))
  const Icon = visual?.icon ?? File

  return (
    <Icon className={cn('h-4 w-4 shrink-0', visual?.className ?? 'text-text-muted', className)} />
  )
}
