import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { User } from '@/types/api'
import '@/i18n'
import { PersonalStandInWorkspace } from './PersonalStandInWorkspace'

vi.mock('./weworkPlatformApi', () => ({
  createWeworkPlatformApi: () => ({ projects: { list: async () => [] } }),
}))
vi.mock('./localWorkspaceApi', () => ({ createLocalWorkspaceApi: () => null }))
vi.mock('./StandInOverviewPage', () => ({
  StandInOverviewPage: ({ initialProfileId }: { initialProfileId: string }) => (
    <input data-testid="retained-role-draft" defaultValue={initialProfileId} />
  ),
}))

it('keeps the owning tab identity and draft when another tab changes the browser query', async () => {
  const props = {
    services: {} as WorkbenchServices,
    user: { id: 7, user_name: 'owner' } as unknown as User,
    devices: [],
    contentRoute: '/stand-in?profileId=reviewer&deviceId=device-a',
    onClose: vi.fn(),
    onOpenTask: vi.fn(),
  }
  const original = window.location.href
  const view = render(<PersonalStandInWorkspace {...props} active />)
  const field = screen.getByTestId('retained-role-draft')
  await userEvent.type(field, ' unsaved')
  try {
    window.history.replaceState({}, '', '/plugins?workspaceTab=plugins')
    view.rerender(<PersonalStandInWorkspace {...props} active={false} />)
    expect(screen.getByTestId('retained-role-draft')).toBe(field)
    expect(field).toHaveValue('reviewer unsaved')
    window.history.replaceState({}, '', '/stand-in?profileId=reviewer&deviceId=device-a')
    view.rerender(<PersonalStandInWorkspace {...props} active />)
    expect(screen.getByTestId('retained-role-draft')).toBe(field)
    expect(field).toHaveValue('reviewer unsaved')
  } finally {
    window.history.replaceState({}, '', original)
  }
})
