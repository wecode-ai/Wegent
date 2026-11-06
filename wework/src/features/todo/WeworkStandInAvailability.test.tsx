import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type {
  CollaborationApp,
  CollaborationProject,
  SharedWorkspaceApi,
} from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import '@/i18n'
import { WeworkSharedProject } from './WeworkCollaborationPlatform'

const experimental = vi.hoisted(() => ({ enabled: false }))
vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => experimental.enabled,
}))
vi.mock('@wegent/collaboration', async importOriginal => ({
  ...(await importOriginal<typeof import('@wegent/collaboration')>()),
  CollaborationApp: (props: ComponentProps<typeof CollaborationApp>) =>
    props.host?.renderProjectHeaderAction?.(props.initialProject!),
}))
vi.mock('./ProjectCoordinatorConversation', () => ({
  ProjectCoordinatorConversation: () => (
    <button data-testid="coordinator-fixture">Coordinator</button>
  ),
}))
vi.mock('./StandInSettingsPage', () => ({
  StandInSettingsPage: () => <p>Project stand-in settings</p>,
}))

describe('project stand-in availability', () => {
  it.each([false, true])(
    'opens the Beta stand-in with experimental features set to %s',
    async enabled => {
      experimental.enabled = enabled
      const project = {
        id: 'project-1',
        name: 'Project',
        project_store: 'local',
      } as CollaborationProject
      render(
        <WeworkSharedProject
          api={
            {
              projects: { list: async () => [project] },
              issues: {},
            } as unknown as SharedWorkspaceApi
          }
          project={project}
          localProjects={[]}
          locale="zh-CN"
          location={{
            platformView: 'project',
            workspaceId: 'space',
            workspaceView: 'projects',
            projectId: project.id,
            projectView: 'board',
            issueId: null,
          }}
          setLocation={vi.fn()}
          userId={7}
          workspace={{ id: 'space', name: 'Space' } as never}
          services={
            {
              getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'device' }),
              standInApi: {
                personalGet: async () => ({
                  userId: 7,
                  executionDeviceId: 'device',
                  version: 0,
                  roles: [],
                }),
              },
            } as unknown as WorkbenchServices
          }
        />
      )
      expect(screen.getByTestId('stand-in-open')).toBeVisible()
      expect(screen.getByTestId('stand-in-project-beta')).toHaveTextContent('Beta')
      expect(Boolean(screen.queryByTestId('coordinator-fixture'))).toBe(enabled)
      await userEvent.click(screen.getByTestId('stand-in-open'))
      expect(await screen.findByText('Project stand-in settings')).toBeVisible()
    }
  )
})
