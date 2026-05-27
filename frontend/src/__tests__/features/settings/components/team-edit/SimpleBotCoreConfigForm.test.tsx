// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

import SimpleBotCoreConfigForm from '@/features/settings/components/team-edit/SimpleBotCoreConfigForm'
import type { UnifiedModel } from '@/apis/models'
import type { UnifiedSkill } from '@/apis/skills'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'common:actions.remove': 'Remove',
        'common:bot.agent_config': 'Model',
        'common:bot.default_knowledge_bases': 'Knowledge bases',
        'common:bot.fine_tune_prompt': 'Optimize',
        'common:bot.model_select': 'Select model',
        'common:bot.no_model_binding': 'No model',
        'common:bot.prompt': 'Prompt',
        'common:bot.prompt_placeholder': 'Write the agent prompt',
        'common:skills.loading_skills': 'Loading skills',
        'common:skills.manage_skills_button': 'Manage',
        'common:skills.select_skill_to_add': 'Select skill',
        'common:skills.skills_section': 'Skills',
      })[key] || key,
  }),
}))

jest.mock('@/components/ui/select', () => ({
  Select: ({
    children,
    onValueChange,
  }: {
    children: ReactNode
    onValueChange?: (value: string) => void
  }) => (
    <div data-testid="model-select" onClick={() => onValueChange?.('gpt-4.1:public:default')}>
      {children}
    </div>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
}))

jest.mock('@/features/settings/components/skills/RichSkillSelector', () => ({
  RichSkillSelector: ({
    skills,
    onSelectSkill,
  }: {
    skills: UnifiedSkill[]
    onSelectSkill: (skill: UnifiedSkill) => void
  }) => (
    <button type="button" onClick={() => onSelectSkill(skills[0])}>
      Add skill
    </button>
  ),
}))

jest.mock('@/features/settings/components/skills/SkillManagementModal', () => () => null)
jest.mock('@/features/prompt-tune/components/PromptFineTuneDialog', () => () => null)
jest.mock('@/features/settings/components/knowledge/KnowledgeBaseMultiSelector', () => ({
  KnowledgeBaseMultiSelector: ({
    onChange,
  }: {
    onChange: (value: Array<{ id: number; name: string }>) => void
  }) => (
    <button type="button" onClick={() => onChange([{ id: 10, name: 'Product Docs' }])}>
      Add knowledge
    </button>
  ),
}))

const models: UnifiedModel[] = [
  { name: 'gpt-4.1', type: 'public', displayName: 'GPT 4.1', namespace: 'default' },
]

const skills: UnifiedSkill[] = [
  {
    id: 5,
    name: 'repo-reader',
    namespace: 'default',
    description: 'Read repository context',
    displayName: 'Repo Reader',
    is_active: true,
    is_public: false,
    user_id: 1,
  },
]

describe('SimpleBotCoreConfigForm', () => {
  it('keeps model, skills, knowledge bases, and prompt in the simple form', () => {
    const onModelChange = jest.fn()
    const onSkillsChange = jest.fn()
    const onKnowledgeChange = jest.fn()
    const onPromptChange = jest.fn()

    render(
      <SimpleBotCoreConfigForm
        modelName=""
        models={models}
        loadingModels={false}
        onModelChange={onModelChange}
        selectedSkills={[]}
        selectedSkillRefs={{}}
        availableSkills={skills}
        allSkills={skills}
        loadingSkills={false}
        onSkillsChange={onSkillsChange}
        onReloadSkills={jest.fn()}
        defaultKnowledgeBaseRefs={[]}
        onDefaultKnowledgeBaseRefsChange={onKnowledgeChange}
        prompt=""
        onPromptChange={onPromptChange}
      />
    )

    expect(screen.getByText('Model')).toBeInTheDocument()
    expect(screen.getByText('Skills')).toBeInTheDocument()
    expect(screen.getByText('Knowledge bases')).toBeInTheDocument()
    expect(screen.getByText('Prompt')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('model-select'))
    expect(onModelChange).toHaveBeenCalledWith({
      name: 'gpt-4.1',
      type: 'public',
      namespace: 'default',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }))
    expect(onSkillsChange).toHaveBeenCalledWith(['repo-reader'], {
      'repo-reader': {
        skill_id: 5,
        namespace: 'default',
        is_public: false,
      },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Add knowledge' }))
    expect(onKnowledgeChange).toHaveBeenCalledWith([{ id: 10, name: 'Product Docs' }])

    fireEvent.change(screen.getByTestId('simple-prompt-textarea'), {
      target: { value: 'Answer clearly.' },
    })
    expect(onPromptChange).toHaveBeenCalledWith('Answer clearly.')
  })
})
