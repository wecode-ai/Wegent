import { render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { expect, it, vi } from 'vitest'
import { ProjectEnvironmentConfiguration } from '../../../packages/collaboration/src/project-manage/ProjectEnvironmentConfiguration'
import { createCollaborationTranslator } from '../../../packages/collaboration/src/i18n'

it('prioritizes the configuration error and restores notice focus when the error clears', () => {
  const props: ComponentProps<typeof ProjectEnvironmentConfiguration> = {
    testIdPrefix: 'environment',
    translate: createCollaborationTranslator('en'),
    canManage: true,
    saving: false,
    workspacePolicy: 'project',
    onWorkspacePolicyChange: vi.fn(),
    repositories: [],
    setupSteps: [],
    repositoryOptions: [],
    repositoriesByUrl: new Map(),
    repositoriesLoadFailed: false,
    branchesByRepository: {},
    loadRepositoryOptions: vi.fn().mockResolvedValue(undefined),
    loadBranches: vi.fn().mockResolvedValue(undefined),
    selectRepository: vi.fn(),
    updateRepository: vi.fn(),
    updateRepositoryUrl: vi.fn(),
    removeRepository: vi.fn(),
    addRepository: vi.fn(),
    addSetupStep: vi.fn(),
    removeSetupStep: vi.fn(),
    updateSetupStep: vi.fn(),
    configurationError: 'Configuration failed',
    configurationConflict: false,
    configurationNotice: 'Configuration saved',
    refreshConfiguration: vi.fn().mockResolvedValue(undefined),
    configurationSaved: false,
    configurationDirty: false,
    saveConfiguration: vi.fn().mockResolvedValue(undefined),
  }
  const { rerender } = render(<ProjectEnvironmentConfiguration {...props} />)
  expect(screen.getByTestId('environment-configuration-error')).toHaveFocus()
  screen.getByTestId('environment-configuration-notice').focus()
  rerender(<ProjectEnvironmentConfiguration {...props} configurationNotice="A new notice" />)
  expect(screen.getByTestId('environment-configuration-error')).toHaveFocus()
  rerender(
    <ProjectEnvironmentConfiguration
      {...props}
      configurationError=""
      configurationNotice="A new notice"
    />
  )
  expect(screen.getByTestId('environment-configuration-notice')).toHaveFocus()
})
