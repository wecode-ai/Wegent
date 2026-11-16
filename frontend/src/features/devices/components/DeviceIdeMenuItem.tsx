// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Code2, Loader2 } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown'
import type { useDeviceIde } from '../hooks/useDeviceIde'

export function DeviceIdeMenuItem({
  ide,
  deviceId,
}: {
  ide: ReturnType<typeof useDeviceIde>
  deviceId: string
}) {
  if (!ide) return null

  const Icon = ide.opening ? Loader2 : Code2

  return (
    <DropdownMenuItem
      data-testid={`device-menu-open-ide-${deviceId}`}
      disabled={Boolean(ide.disabledReason) || ide.opening}
      aria-busy={ide.opening}
      className="min-h-11 gap-2 md:min-h-0"
      onSelect={() => void ide.open()}
    >
      <Icon aria-hidden="true" className={ide.opening ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
      <span>
        {ide.label}
        {ide.disabledReason && (
          <span className="block text-xs text-text-muted">{ide.disabledReason}</span>
        )}
      </span>
    </DropdownMenuItem>
  )
}
