import { render, screen, waitFor } from '@testing-library/react'
import GitHubIntegration from '@/features/settings/components/GitHubIntegration'

const mockUser = { id: 1, git_info: [] as Array<Record<string, unknown>> }
const mockRefresh = jest.fn()
const mockToast = jest.fn()
const mockTranslate = (key: string) => key
jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('gitDomain=git.example%3A8443'),
}))
jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ user: mockUser, refresh: mockRefresh }),
}))
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockTranslate }),
}))
jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))
jest.mock('@/features/settings/components/GitHubEdit', () => ({
  __esModule: true,
  default: (props: {
    isOpen: boolean
    initialDomain?: string
    mode: string
    editInfo?: { id?: string }
  }) =>
    props.isOpen ? (
      <div data-testid="targeted-git-form" data-mode={props.mode} data-account={props.editInfo?.id}>
        {props.initialDomain}
      </div>
    ) : null,
}))

describe('targeted Git account configuration', () => {
  test('opens a domain-prefilled add form when the exact domain is missing', async () => {
    mockUser.git_info = []
    render(<GitHubIntegration />)
    const form = await screen.findByTestId('targeted-git-form')
    expect(form).toHaveTextContent('git.example:8443')
    expect(form).toHaveAttribute('data-mode', 'add')
  })

  test('edits the first effective exact-domain account instead of creating a duplicate', async () => {
    mockUser.git_info = [
      { id: 'other-port', git_domain: 'git.example', git_token: 'synthetic', type: 'gitlab' },
      {
        id: 'effective',
        git_domain: 'https://Git.Example:8443/',
        git_token: 'synthetic',
        type: 'gitlab',
      },
      { id: 'duplicate', git_domain: 'git.example:8443', git_token: 'synthetic', type: 'gitlab' },
    ]
    render(<GitHubIntegration />)
    await waitFor(() =>
      expect(screen.getByTestId('targeted-git-form')).toHaveAttribute('data-account', 'effective')
    )
    expect(screen.getByTestId('targeted-git-form')).toHaveAttribute('data-mode', 'edit')
  })
})
