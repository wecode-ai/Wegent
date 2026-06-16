import type { ReactNode } from 'react'
import { LocalManagementSection } from '@wecode/features/local-executor/LocalManagementSection'
import type { DeviceInfo } from '@/types/devices'

interface AppsPageExtensionContext {
  devices: DeviceInfo[]
}

interface AppsPageSectionExtension {
  key: string
  label: string
  render: (context: AppsPageExtensionContext) => ReactNode
}

export const appsPageSectionExtensions: AppsPageSectionExtension[] = [
  {
    key: 'local-management',
    label: '本机管理',
    render: ({ devices }) => <LocalManagementSection devices={devices} />,
  },
]
