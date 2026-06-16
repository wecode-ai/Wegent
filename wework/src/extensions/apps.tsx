import type { ReactNode } from 'react'
import type { DeviceInfo } from '@/types/devices'

export interface AppsPageExtensionContext {
  devices: DeviceInfo[]
}

export interface AppsPageSectionExtension {
  key: string
  label: string
  render: (context: AppsPageExtensionContext) => ReactNode
}

export const appsPageSectionExtensions: AppsPageSectionExtension[] = []
