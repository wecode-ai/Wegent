import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import GitHubEdit from '@/features/settings/components/GitHubEdit'

const mockUser = { id: 1, git_info: [] }
const mockRefresh = jest.fn()
const mockToast = jest.fn()
const mockTranslate = (key: string) => key
jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: mockUser, refresh: mockRefresh }),
}))
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}))
jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }))
jest.mock('@/features/common/Modal', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

test('target domain and port survive changing the provider', async () => {
  render(
    <GitHubEdit
      isOpen
      onClose={jest.fn()}
      mode="add"
      editInfo={null}
      initialDomain="git.example:8443"
    />
  )
  await waitFor(() =>
    expect(screen.getByTestId('git-account-domain-input')).toHaveValue('git.example:8443')
  )
  await userEvent.click(screen.getByTestId('gitea-platform-radio'))
  expect(screen.getByTestId('gitea-platform-radio')).toBeChecked()
  expect(screen.getByTestId('git-account-domain-input')).toHaveValue('git.example:8443')
})
