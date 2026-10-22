// @vitest-environment jsdom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { ProjectAgentPicker } from './ProjectAgentPicker'

const agents = [
  {
    id: 'personal',
    name: 'Code reviewer',
    team_id: 12,
    owner_type: 'user' as const,
    owner_id: '1',
    owner_name: 'Alice',
    status: 'available' as const,
  },
  {
    id: 'shared',
    name: '规划助手',
    team_id: 13,
    owner_type: 'workspace' as const,
    owner_id: 'space',
    owner_name: '研发空间',
    status: 'available' as const,
  },
]

describe('ProjectAgentPicker', () => {
  let root: Root
  let container: HTMLDivElement
  let props: ComponentProps<typeof ProjectAgentPicker>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    props = {
      agents,
      addedTeamIds: new Set(),
      selectedId: '',
      loading: false,
      loadError: null,
      error: null,
      busy: false,
      scope: 'project',
      translate: createCollaborationTranslator('zh-CN'),
      onSelect: vi.fn(),
      onRetry: vi.fn(),
      onCreate: vi.fn(),
      onClose: vi.fn(),
      onAdd: vi.fn(),
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function get<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = container.querySelector(`[data-testid="${id}"]`)
    if (!(element instanceof HTMLElement)) throw new Error(`Missing ${id}`)
    return element as T
  }

  function render(overrides: Partial<typeof props> = {}) {
    props = { ...props, ...overrides }
    act(() => root.render(<ProjectAgentPicker {...props} />))
  }

  function search(value: string) {
    const input = get<HTMLInputElement>('project-agent-search')
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('keeps search, creation and footer available while candidates load', () => {
    render({ loading: true })
    const content = get('project-agent-picker-content')
    expect(content.getAttribute('aria-busy')).toBe('true')
    expect(get('project-agent-candidates-loading').textContent).toContain(
      '正在加载智能体',
    )
    expect(get<HTMLButtonElement>('project-agent-wegent-create').disabled).toBe(
      true,
    )
    act(() => get('project-agent-mode-create').click())
    expect(props.onCreate).toHaveBeenCalledOnce()

    render({ loading: false })
    expect(get('project-agent-picker-content')).toBe(content)
    expect(content.getAttribute('aria-busy')).toBe('false')
    expect(get('project-agent-option-12')).toBeTruthy()
    expect(get('project-agent-selection-summary').textContent).toBe(
      '选择智能体后即可添加',
    )
  })

  it('filters names and owners locally, clears unmatched searches and retains selection', () => {
    render({ selectedId: '12' })
    search('  ALICE  ')
    expect(get('project-agent-option-12')).toBeTruthy()
    expect(
      container.querySelector('[data-testid="project-agent-option-13"]'),
    ).toBeNull()
    search('研发空间')
    expect(get('project-agent-option-13')).toBeTruthy()
    expect(
      container.querySelector('[data-testid="project-agent-option-12"]'),
    ).toBeNull()
    expect(get('project-agent-selection-summary').textContent).toContain(
      'Code reviewer',
    )
    expect(get<HTMLButtonElement>('project-agent-wegent-create').disabled).toBe(
      false,
    )

    search('missing')
    expect(get('project-agent-wegent-empty').textContent).toContain('没有匹配')
    act(() => get('project-agent-search-clear').click())
    expect(get<HTMLInputElement>('project-agent-search').value).toBe('')
    expect(document.activeElement).toBe(get('project-agent-search'))
    expect(get<HTMLInputElement>('project-agent-option-12').checked).toBe(true)
  })

  it('prevents duplicate additions and enables submission only after a usable selection', () => {
    render({ addedTeamIds: new Set([12]) })
    expect(get<HTMLInputElement>('project-agent-option-12').disabled).toBe(true)
    expect(get<HTMLButtonElement>('project-agent-wegent-create').disabled).toBe(
      true,
    )
    act(() => get('project-agent-option-13').click())
    expect(props.onSelect).toHaveBeenCalledWith('13')
    render({ selectedId: '13' })
    act(() => get('project-agent-wegent-create').click())
    expect(props.onAdd).toHaveBeenCalledOnce()

    render({ busy: true })
    expect(get<HTMLButtonElement>('project-agent-wegent-create').disabled).toBe(
      true,
    )
    expect(get<HTMLInputElement>('project-agent-option-13').disabled).toBe(true)
    expect(get<HTMLInputElement>('project-agent-search').disabled).toBe(true)
    expect(get<HTMLButtonElement>('project-agent-mode-create').disabled).toBe(
      true,
    )
    expect(get<HTMLButtonElement>('project-agent-dialog-cancel').disabled).toBe(
      true,
    )
  })

  it('offers retry and creation after a load failure and preserves an add error with selection', () => {
    render({ loadError: 'Connection lost' })
    expect(get('project-agent-candidates-error').textContent).toContain(
      'Connection lost',
    )
    act(() => get('project-agent-candidates-retry').click())
    expect(props.onRetry).toHaveBeenCalledOnce()
    act(() => get('project-agent-mode-create').click())
    expect(props.onCreate).toHaveBeenCalledOnce()
    render({ loadError: null, selectedId: '13', error: 'Unable to add' })
    expect(get('project-agent-dialog-error').textContent).toBe('Unable to add')
    expect(get<HTMLInputElement>('project-agent-option-13').checked).toBe(true)
    expect(get<HTMLButtonElement>('project-agent-wegent-create').disabled).toBe(
      false,
    )
  })

  it('shows actionable empty copy and translates the workspace purpose and disclosure', () => {
    render({ agents: [] })
    expect(get('project-agent-wegent-empty').textContent).toContain(
      '新建一个智能体',
    )
    render({ onCreate: undefined })
    expect(get('project-agent-wegent-empty').textContent).toContain(
      '空间管理员',
    )
    render({
      scope: 'workspace',
      translate: createCollaborationTranslator('en'),
    })
    expect(container.textContent).toContain(
      'Projects in this space can reuse this agent',
    )
    expect(get('project-agent-wegent-create').textContent).toBe('Add to space')
  })
})
