import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { GitAccountConfigurationButton } from '@wegent/collaboration/controls'
import { createCollaborationTranslator } from '@wegent/collaboration'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import { DesktopGitAccountConfigurationProvider } from './DesktopGitAccountConfigurationProvider'

const cloud = vi.hoisted(() => ({
  isConnected: true,
  webUrl: 'https://cloud.example',
  backendUrl: 'https://backend.example',
}))
const openExternalUrl = vi.hoisted(() => vi.fn().mockResolvedValue(true))
vi.mock('@/features/cloud-connection/useCloudConnection', () => ({
  useOptionalCloudConnection: () => cloud,
}))
vi.mock('@/lib/external-links', () => ({ openExternalUrl }))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: vi.fn() }))

function surface(
  deviceType: string,
  bindShell = 'claudecode',
  explicitTarget = true,
  conversation = true
) {
  const value = {
    state: {
      devices: [
        {
          id: 1,
          device_id: 'target',
          device_type: deviceType,
          bind_shell: bindShell,
          name: 'Executor',
          status: 'online',
          is_default: true,
        },
      ],
      currentRuntimeTask: { deviceId: 'target', taskId: 'task' },
    },
  } as unknown as ComponentProps<typeof WorkbenchContext.Provider>['value']
  return (
    <WorkbenchContext.Provider value={value}>
      <DesktopGitAccountConfigurationProvider
        conversation={conversation}
        deviceId={conversation && explicitTarget ? 'target' : undefined}
      >
        <GitAccountConfigurationButton
          failure={{
            code: 'credentials-required',
            domain: 'git.example:8443',
            message: 'Git failed',
          }}
          translate={createCollaborationTranslator('zh-CN')}
          testId="configure"
          deviceId={!conversation ? 'target' : undefined}
        />
      </DesktopGitAccountConfigurationProvider>
    </WorkbenchContext.Provider>
  )
}

function mount(...args: Parameters<typeof surface>) {
  return render(surface(...args))
}

describe('desktop Git account configuration routing', () => {
  beforeEach(() => {
    cloud.isConnected = true
    cloud.webUrl = 'https://cloud.example'
    openExternalUrl.mockClear()
  })

  it.each([true, false])(
    'waits for Web metadata and recovers navigation (conversation=%s)',
    conversation => {
      cloud.webUrl = ''
      const { rerender } = mount('remote', 'claudecode', true, conversation)
      expect(screen.queryByTestId('configure')).toBeNull()
      expect(openExternalUrl).not.toHaveBeenCalled()
      cloud.webUrl = 'https://web.example/wegent'
      rerender(surface('remote', 'claudecode', true, conversation))
      fireEvent.click(screen.getByTestId('configure'))
      expect(openExternalUrl).toHaveBeenCalledWith(
        'https://web.example/wegent/settings?tab=integrations&gitDomain=git.example%3A8443#git-accounts',
        { source: 'git-access-recovery' }
      )
    }
  )
  it('keeps a conversation without a workbench context usable', () => {
    render(
      <DesktopGitAccountConfigurationProvider conversation>
        <GitAccountConfigurationButton
          failure={{
            code: 'credentials-required',
            domain: 'git.example:8443',
            message: 'Git failed',
          }}
          translate={createCollaborationTranslator('zh-CN')}
          testId="configure"
        />
      </DesktopGitAccountConfigurationProvider>
    )
    expect(screen.queryByTestId('configure')).toBeNull()
  })

  it.each(['cloud', 'remote'])('uses cloud web settings for a managed %s executor', async type => {
    openExternalUrl.mockClear()
    mount(type)
    fireEvent.click(screen.getByTestId('configure'))
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://cloud.example/settings?tab=integrations&gitDomain=git.example%3A8443#git-accounts',
      { source: 'git-access-recovery' }
    )
  })

  it('uses the current runtime target when a direct message has no image target', () => {
    mount('remote', 'claudecode', false)
    expect(screen.getByTestId('configure')).toBeInTheDocument()
  })

  it.each(['local', 'app'])('does not send native %s Git to cloud account configuration', type => {
    mount(type)
    expect(screen.queryByTestId('configure')).toBeNull()
  })

  it.each(['local', 'app', 'remote', 'cloud'])(
    'uses actual %s device identity on the execution environment page',
    type => {
      mount(type, 'claudecode', true, false)
      expect(Boolean(screen.queryByTestId('configure'))).toBe(['remote', 'cloud'].includes(type))
    }
  )

  it('does not offer cloud credential synchronization for another shell', () => {
    mount('remote', 'codex')
    expect(screen.queryByTestId('configure')).toBeNull()
  })

  it('removes configuration navigation after cloud disconnection', () => {
    cloud.isConnected = false
    try {
      mount('remote')
      expect(screen.queryByTestId('configure')).toBeNull()
    } finally {
      cloud.isConnected = true
    }
  })
})
