// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'

import SimpleTeamEditForm from '@/features/settings/components/team-edit/SimpleTeamEditForm'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'settings:team.simple.sections.basic': 'Basic',
        'settings:team.simple.sections.execution': 'Execution',
        'settings:team.simple.sections.prompt': 'Prompt',
        'settings:team.simple.sections.capability': 'Capability',
        'settings:team.simple.prompt_protection.label': 'Prompt protection',
        'settings:team.simple.prompt_protection.description':
          'Best-effort extra model call; not a security boundary.',
      })[key] || key,
  }),
}))

jest.mock('@/components/model-select/ModelCascadeSelect', () => ({
  GroupedModelSelect: () => <div />,
}))
jest.mock('@/features/prompt-tune/components/PromptFineTuneDialog', () => () => null)
jest.mock('@/features/settings/components/McpConfigSection', () => () => null)
jest.mock('@/features/settings/components/knowledge/KnowledgeBaseMultiSelector', () => ({
  KnowledgeBaseMultiSelector: () => null,
}))
jest.mock('@/features/settings/components/skills/SkillManagementModal', () => () => null)
jest.mock('@/features/settings/components/skills/RichSkillSelector', () => ({
  RichSkillSelector: () => null,
}))
jest.mock('@/features/settings/components/teams/TeamIconPicker', () => ({
  TeamIconPicker: () => null,
}))
jest.mock('@/features/settings/components/team-edit/ExecutorModeSelector', () => () => null)
jest.mock('@/features/settings/components/team-edit/QuickPhraseEditor', () => () => null)
jest.mock('@/features/settings/components/team-edit/InputPlaceholderEditor', () => () => null)
jest.mock('@/features/settings/components/team-edit/TeamBindModeCards', () => () => null)

describe('SimpleTeamEditForm prompt protection', () => {
  it('renders a stable switch and forwards changes', () => {
    const setPromptProtectionEnabled = jest.fn()

    render(
      <SimpleTeamEditForm
        name="support"
        setName={jest.fn()}
        displayName="Support"
        setDisplayName={jest.fn()}
        description="Support users"
        setDescription={jest.fn()}
        promptProtectionEnabled={false}
        setPromptProtectionEnabled={setPromptProtectionEnabled}
        quickPhrases={[]}
        onQuickPhrasesChange={jest.fn()}
        inputPlaceholder={{}}
        onInputPlaceholderChange={jest.fn()}
        bindMode={['chat']}
        setBindMode={jest.fn()}
        icon={null}
        setIcon={jest.fn()}
        requiresWorkspace={false}
        setRequiresWorkspace={jest.fn()}
        executorMode="simple"
        setExecutorMode={jest.fn()}
        shells={[]}
        customShellName=""
        setCustomShellName={jest.fn()}
        modelName=""
        models={[]}
        loadingModels={false}
        onModelChange={jest.fn()}
        selectedSkills={[]}
        selectedSkillRefs={{}}
        preloadSkills={[]}
        onPreloadSkillsChange={jest.fn()}
        supportsPreloadSkills={false}
        availableSkills={[]}
        allSkills={[]}
        loadingSkills={false}
        onSkillsChange={jest.fn()}
        onReloadSkills={jest.fn()}
        defaultKnowledgeBaseRefs={[]}
        onDefaultKnowledgeBaseRefsChange={jest.fn()}
        mcpConfig=""
        onMcpConfigChange={jest.fn()}
        prompt=""
        onPromptChange={jest.fn()}
        toast={jest.fn()}
      />
    )

    const toggle = screen.getByRole('switch', { name: 'Prompt protection' })
    expect(toggle).toHaveAttribute('data-testid', 'prompt-protection-enabled-switch')
    expect(toggle).not.toBeChecked()
    const hitTarget = toggle.parentElement
    expect(hitTarget?.tagName).toBe('LABEL')
    expect(hitTarget).toHaveClass('min-h-11', 'min-w-11', 'justify-start', 'md:justify-end')
    expect(screen.getByText('Prompt protection')).toBeInTheDocument()
    fireEvent.click(hitTarget!)
    expect(setPromptProtectionEnabled).toHaveBeenCalledWith(true)
  })
})
