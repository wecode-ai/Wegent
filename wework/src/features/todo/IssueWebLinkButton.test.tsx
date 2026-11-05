import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { CloudProject } from '@/api/deliveries'
import {
  CloudConnectionContext,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'
import { copyTextToClipboard } from '@/lib/clipboard'
import { IssueWebLinkButton } from './IssueWebLinkButton'

vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

function setup(
  store: 'local' | 'backend' = 'backend',
  webUrl: string | null = 'https://wegent.example/'
) {
  const project = { id: 'project/1', workspace_id: 'space 1', project_store: store } as CloudProject
  const cloud = { webUrl } as CloudConnectionContextValue
  const view = render(
    <CloudConnectionContext.Provider value={cloud}>
      <IssueWebLinkButton project={project} issueId="ISSUE/2 #" />
    </CloudConnectionContext.Provider>
  )
  return { ...view, project, cloud }
}

describe('Issue web link', () => {
  it('copies the current Wegent website URL with encoded workspace, project and Issue IDs', async () => {
    setup()
    await userEvent.click(screen.getByTestId('issue-copy-web-link'))
    expect(copyTextToClipboard).toHaveBeenCalledWith(
      'https://wegent.example/collaboration/workspaces/space%201/projects/project%2F1/issues/ISSUE%2F2%20%23'
    )
    expect(screen.getByTestId('issue-copy-web-link')).toHaveAccessibleName('已复制')
  })

  it('uses the supported project redirect route when workspace metadata is unavailable', async () => {
    const { rerender, project, cloud } = setup()
    rerender(
      <CloudConnectionContext.Provider value={cloud}>
        <IssueWebLinkButton project={{ ...project, workspace_id: null }} issueId="ISSUE-1" />
      </CloudConnectionContext.Provider>
    )
    await userEvent.click(screen.getByTestId('issue-copy-web-link'))
    expect(copyTextToClipboard).toHaveBeenCalledWith(
      'https://wegent.example/collaboration/project%2F1/issues/ISSUE-1'
    )
  })

  it.each([
    ['local', 'https://wegent.example'],
    ['backend', null],
  ] as const)('hides the action for store %s and website %s', (store, webUrl) => {
    setup(store, webUrl)
    expect(screen.queryByTestId('issue-copy-web-link')).not.toBeInTheDocument()
  })

  it('reports clipboard failure and lets the user retry', async () => {
    vi.mocked(copyTextToClipboard).mockRejectedValueOnce(new Error('Clipboard unavailable'))
    setup()
    await userEvent.click(screen.getByTestId('issue-copy-web-link'))
    await waitFor(() =>
      expect(screen.getByTestId('issue-copy-web-link')).toHaveAccessibleName('复制失败，请重试')
    )
    await userEvent.click(screen.getByTestId('issue-copy-web-link'))
    expect(screen.getByTestId('issue-copy-web-link')).toHaveAccessibleName('已复制')
    expect(copyTextToClipboard).toHaveBeenCalledTimes(2)
  })
})
