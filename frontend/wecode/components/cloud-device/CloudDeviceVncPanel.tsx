// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { VncToggle } from './VncToggle'

interface CloudDeviceVncPanelProps {
  readonly isVncOpen: boolean
  readonly onToggleVnc: () => void
}

/**
 * Cloud device VNC panel control.
 *
 * Renders a toggle button in the top navigation bar to open/close
 * the embedded VNC viewer panel.
 */
export function CloudDeviceVncPanel({ isVncOpen, onToggleVnc }: CloudDeviceVncPanelProps) {
  return <VncToggle isOpen={isVncOpen} onToggle={onToggleVnc} />
}

export default CloudDeviceVncPanel
