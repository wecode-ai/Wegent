import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import '@/i18n'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { IssueHumanRequests } from './IssueHumanRequests'

it.each([
  { profile: undefined, recipient: 0, canReply: true },
  { profile: 7, recipient: 7, canReply: true },
  { profile: 7, recipient: 0, canReply: false },
])(
  'requires the exact composed author, not an implicit alias ($profile/$recipient)',
  async ({ profile, recipient, canReply }) => {
    const services = {
      ...(profile === undefined
        ? {}
        : {
            localParticipationIdentity: {
              nativeOwnerUserId: 0,
              currentUser: { id: profile, user_name: 'Verified participant' },
              viewerUserIds: [0, profile],
            },
          }),
      localIssueHumanRequestsApi: {
        list: vi.fn().mockResolvedValue({
          items: [
            {
              id: 'question',
              project_id: 'project',
              issue_id: 'ISSUE-1',
              root_comment_id: 'root',
              runtime_device_id: 'device',
              runtime_task_id: 'runtime',
              item_id: 'native-question',
              question: 'Choose the release scope',
              questions: [
                {
                  id: 'scope',
                  question: 'Choose the release scope',
                  options: [{ label: 'Internal' }, { label: 'Public' }],
                },
              ],
              status: 'pending',
              version: 1,
              recipient_user_id: recipient,
              recipient_name: 'local',
              blocks_progress: true,
              created_at: '2026-11-08T00:00:00Z',
              updated_at: '2026-11-08T00:00:00Z',
              waiting_since: '2026-11-08T00:00:00Z',
            },
          ],
        }),
      },
    } as unknown as WorkbenchServices
    render(
      <IssueHumanRequests
        services={services}
        projectId="project"
        issueId="ISSUE-1"
        store="local"
        userId={999}
        members={[]}
      />
    )
    expect(await screen.findByText('Choose the release scope')).toBeVisible()
    expect(screen.getByText('Internal')).toBeVisible()
    if (canReply) expect(screen.getByText('Internal').closest('button')).not.toBeDisabled()
    else expect(screen.getByText('Internal').closest('button')).toBeDisabled()
    if (profile !== undefined)
      expect(screen.getByRole('option', { name: 'Verified participant' })).toHaveValue(
        String(profile)
      )
    expect(screen.getByTestId('issue-human-requests')).toBeVisible()
    expect(screen.getByTestId('issue-waiting-time')).toBeVisible()
  }
)
