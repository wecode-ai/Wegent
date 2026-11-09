import { render, screen, waitFor } from '@testing-library/react'
import GitHubIntegration from '@/features/settings/components/GitHubIntegration'

const mockContext = {
  user: { id: 1, git_info: [] as Array<Record<string, unknown>> } as {
    id: number
    git_info: Array<Record<string, unknown>>
  } | null,
  isLoading: false,
}
const mockRefresh = jest.fn()
const mockToast = jest.fn()
const mockTranslate = (key: string) => key
jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('gitDomain=git.example%3A8443'),
}))
jest.mock('@/features/common/UserContext', () => ({
  useUser: () => ({ ...mockContext, refresh: mockRefresh }),
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
  beforeEach(() => {
    mockContext.user = { id: 1, git_info: [] }
    mockContext.isLoading = false
  })

  test('opens a domain-prefilled add form when the exact domain is missing', async () => {
    render(<GitHubIntegration />)
    const form = await screen.findByTestId('targeted-git-form')
    expect(form).toHaveTextContent('git.example:8443')
    expect(form).toHaveAttribute('data-mode', 'add')
  })

  test('edits the first effective exact-domain account instead of creating a duplicate', async () => {
    mockContext.user!.git_info = [
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

  test('waits for the current user before choosing an existing account', async () => {
    mockContext.user = null
    mockContext.isLoading = true
    const { rerender } = render(<GitHubIntegration />)
    expect(screen.queryByTestId('targeted-git-form')).not.toBeInTheDocument()

    mockContext.user = {
      id: 1,
      git_info: [{ id: 'loaded-account', git_domain: 'git.example:8443', git_token: 'synthetic' }],
    }
    mockContext.isLoading = false
    rerender(<GitHubIntegration />)
    await waitFor(() =>
      expect(screen.getByTestId('targeted-git-form')).toHaveAttribute(
        'data-account',
        'loaded-account'
      )
    )
    expect(screen.getByTestId('targeted-git-form')).toHaveAttribute('data-mode', 'edit')
  })

  test('does not reuse the previous user account for the same requested domain', async () => {
    mockContext.user = {
      id: 1,
      git_info: [{ id: 'owner-a', git_domain: 'git.example:8443', git_token: 'synthetic' }],
    }
    const { rerender } = render(<GitHubIntegration />)
    expect(await screen.findByTestId('targeted-git-form')).toHaveAttribute(
      'data-account',
      'owner-a'
    )

    mockContext.user = {
      id: 2,
      git_info: [{ id: 'owner-b', git_domain: 'git.example:8443', git_token: 'synthetic' }],
    }
    rerender(<GitHubIntegration />)
    await waitFor(() =>
      expect(screen.getByTestId('targeted-git-form')).toHaveAttribute('data-account', 'owner-b')
    )
  })
})
