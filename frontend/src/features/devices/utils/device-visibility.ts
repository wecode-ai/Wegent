// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { DeviceInfo } from '@/apis/devices'

/**
 * Return whether a device can be exposed as an execution target in Wegent web.
 * App-only registrations are local Wework connections and reject backend dispatch.
 */
export function isWegentExecutionDevice(device: DeviceInfo): boolean {
  return device.device_type !== 'app'
}
