import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { DeviceInfo } from '@/types/api'
import { StandInDeviceSelect } from '@/features/todo/StandInDeviceSelect'
const meta = {
  title: 'Business/DeviceSelect',
  component: StandInDeviceSelect,
  parameters: {
    docs: {
      description: {
        component:
          'Device IDs and offline eligibility stay in the host adapter; the menu uses the shared UI SDK Select. / 宿主负责设备标识与离线限制，底层统一使用 UI SDK Select。',
      },
    },
  },
} satisfies Meta<typeof StandInDeviceSelect>
export default meta
type Story = StoryObj<Record<string, never>>
const devices: DeviceInfo[] = [
  { id: 1, device_id: 'current', name: 'Example desktop', status: 'online', is_default: true },
  { id: 2, device_id: 'remote', name: 'Example remote', status: 'online', is_default: false },
  { id: 3, device_id: 'offline', name: 'Example offline', status: 'offline', is_default: false },
]
function Example({
  disabled = false,
  readOnly = false,
}: {
  disabled?: boolean
  readOnly?: boolean
}) {
  const [value, setValue] = useState('current')
  return (
    <StandInDeviceSelect
      devices={devices}
      value={value}
      currentDeviceId="current"
      disabled={disabled}
      readOnly={readOnly}
      onChange={setValue}
      testId="catalog-device"
    />
  )
}
export const Default: Story = { render: () => <Example /> }
export const Disabled: Story = { render: () => <Example disabled /> }
export const ReadOnly: Story = { render: () => <Example readOnly /> }
