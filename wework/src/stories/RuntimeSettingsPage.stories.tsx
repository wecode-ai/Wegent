import { useMemo, useState, type ComponentProps } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { RuntimeProfile } from '@/api/runtimeProfiles'
import { RuntimeSettingsPage } from '@/components/settings/RuntimeSettingsPage'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

const meta = {
  title: 'Pages/RuntimeSettings',
  component: RuntimeSettingsPage,
  parameters: {
    docs: {
      description: {
        component:
          'Real settings page with in-memory public service ports. CRUD changes stay in this preview. / 真实 Runtime 设置界面，服务端口使用本地状态，增删只影响当前示例。',
      },
    },
  },
} satisfies Meta<typeof RuntimeSettingsPage>
export default meta
type Story = StoryObj<Record<string, never>>
type PagePorts = ComponentProps<typeof RuntimeSettingsPage>

function Example({ empty = false, failed = false, pending = false, loading = false }) {
  const { t } = useTranslation('componentCatalog')
  const [result, setResult] = useState('')
  const [release, setRelease] = useState<(() => void) | null>(null)
  const ports = useMemo<PagePorts>(() => {
    let listAttempts = 0
    let createdCount = 0
    const initialProfiles: RuntimeProfile[] = empty
      ? []
      : [
          {
            id: 'preview-runtime',
            name: 'Example Runtime · 项目运行环境',
            model: 'Example model',
            executionEnvironment: 'local',
            executionDeviceId: 'preview-device',
            modelType: 'runtime',
            modelOptions: {},
            workspacePolicy: 'current',
            status: 'active',
            version: 1,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ]
    const profiles = new Map(initialProfiles.map(profile => [profile.id, profile]))
    return {
      runtimeProfileApi: {
        list: async () => {
          if (loading) {
            await new Promise<void>(resolve => setRelease(() => resolve))
            setRelease(null)
          }
          if (failed && listAttempts++ === 0)
            throw new Error('Example service unavailable / 示例服务不可用')
          return [...profiles.values()]
        },
        create: async input => {
          const profile: RuntimeProfile = {
            ...input,
            id: `preview-created-${++createdCount}`,
            model: input.model ?? '',
            modelType: input.modelType ?? 'runtime',
            modelOptions: input.modelOptions ?? {},
            workspacePolicy: input.workspacePolicy ?? 'current',
            status: 'active',
            version: 1,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          }
          profiles.set(profile.id, profile)
          setResult(profile.name)
          return profile
        },
        delete: async id => {
          if (pending) await new Promise<void>(resolve => setRelease(() => resolve))
          profiles.delete(id)
          setRelease(null)
          setResult(id)
        },
        getProjectDefault: async projectId => ({
          projectId: String(projectId),
          userId: 1,
          runtimeProfileId: null,
        }),
        setProjectDefault: async (projectId, runtimeProfileId) => ({
          projectId: String(projectId),
          userId: 1,
          runtimeProfileId,
        }),
      },
      deviceApi: {
        listDevices: async () => [
          {
            id: 1,
            device_id: 'preview-device',
            name: 'Example desktop',
            status: 'online',
            is_default: true,
            device_type: 'local',
            bind_shell: 'claudecode',
          },
        ],
      },
      modelApi: {
        listModels: async () => ({
          data: [{ name: 'Example model', type: 'runtime', provider: 'local', config: {} }],
        }),
      },
    }
  }, [empty, failed, pending, loading])
  return (
    <>
      <RuntimeSettingsPage {...ports} />
      {release && (
        <Button data-testid="catalog-runtime-finish" onClick={() => release()}>
          {t('save')}
        </Button>
      )}
      <output data-testid="catalog-runtime-result">{result}</output>
    </>
  )
}
export const Ready: Story = { render: () => <Example /> }
export const Empty: Story = { render: () => <Example empty /> }
export const LoadFailure: Story = { render: () => <Example failed /> }
export const DeletePending: Story = { render: () => <Example pending /> }
export const Unavailable: Story = { render: () => <RuntimeSettingsPage /> }

export const Loading: Story = { render: () => <Example loading /> }
