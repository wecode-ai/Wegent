// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * The selector preselects so nobody has to pick the same model every time, and the
 * remembered choice is supposed to win. It did not: the team id it needs to read the
 * cache arrives after the model list does, and by then the selector had already
 * fallen back to whichever model sorted first. Its own re-attempt logic could never
 * run, because a value being set was the first thing it checked for.
 *
 * The symptom was the dialog opening on the same wrong model every time, however
 * often a different one was chosen and saved.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ModelRefSelector } from '@/components/model-select/ModelRefSelector'
import { getGlobalModelPreference, saveGlobalModelPreference } from '@/utils/modelPreferences'
import { modelApis } from '@/apis/models'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback || key }),
}))

jest.mock('@/apis/models', () => ({
  modelApis: { getUnifiedModels: jest.fn() },
}))

const TEAM_ID = 7

// Sorted by display name, so "aaa" is what an unguided fallback lands on and "zzz"
// is only ever reached by remembering it.
const MODELS = [
  { name: 'aaa-default', namespace: 'default', type: 'public', displayName: 'AAA' },
  { name: 'zzz-remembered', namespace: 'default', type: 'public', displayName: 'ZZZ' },
]

function remember(modelName: string, scope?: 'summary' | 'wiki') {
  saveGlobalModelPreference(
    TEAM_ID,
    { modelName, modelType: 'public', forceOverride: true, updatedAt: Date.now() },
    undefined,
    scope
  )
}

function renderSelector(props: {
  value: { name: string; namespace: string; type: 'public' } | null
  onChange: jest.Mock
  teamId?: number
  scope?: 'summary' | 'wiki'
}) {
  return render(
    <ModelRefSelector
      value={props.value}
      onChange={props.onChange}
      placeholder="pick"
      knowledgeDefaultTeamId={props.teamId}
      preferenceScope={props.scope}
      dataTestId="model-select"
    />
  )
}

describe('preselecting the remembered model', () => {
  beforeEach(() => {
    localStorage.clear()
    jest.clearAllMocks()
    ;(modelApis.getUnifiedModels as jest.Mock).mockResolvedValue({ data: MODELS })
  })

  it('uses the remembered model when the team is known up front', async () => {
    remember('zzz-remembered')
    const onChange = jest.fn()

    renderSelector({ value: null, onChange, teamId: TEAM_ID })

    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(onChange.mock.calls[0][0].name).toBe('zzz-remembered')
  })

  it('still uses it when the team id only arrives after the models', async () => {
    remember('zzz-remembered')
    const onChange = jest.fn()
    const { rerender } = renderSelector({ value: null, onChange })

    // Without a team there is no cache to read, so it guesses.
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    const guess = onChange.mock.calls[0][0]
    expect(guess.name).toBe('aaa-default')

    // The parent stores the guess and the team info lands.
    rerender(
      <ModelRefSelector
        value={guess}
        onChange={onChange}
        placeholder="pick"
        knowledgeDefaultTeamId={TEAM_ID}
        dataTestId="model-select"
      />
    )

    await waitFor(() => {
      const latest = onChange.mock.calls[onChange.mock.calls.length - 1][0]
      expect(latest.name).toBe('zzz-remembered')
    })
  })

  it('leaves a value the caller loaded alone', async () => {
    // An existing knowledge base's own model. Replacing it with a remembered one
    // would silently rewrite the setting just by opening the edit dialog.
    remember('zzz-remembered')
    const onChange = jest.fn()

    renderSelector({
      value: { name: 'aaa-default', namespace: 'default', type: 'public' },
      onChange,
      teamId: TEAM_ID,
    })

    await waitFor(() => expect(modelApis.getUnifiedModels).toHaveBeenCalled())
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('remembering a deliberate choice', () => {
  beforeEach(() => {
    localStorage.clear()
    jest.clearAllMocks()
    ;(modelApis.getUnifiedModels as jest.Mock).mockResolvedValue({ data: MODELS })
  })

  it('remembers as soon as it is picked, not when the form is submitted', async () => {
    // A dialog closed without submitting used to forget the choice entirely, so
    // the next one opened on the fallback however many times a model was chosen.
    const onChange = jest.fn()
    renderSelector({ value: null, onChange, teamId: TEAM_ID })
    await waitFor(() => expect(onChange).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId('model-select'))
    fireEvent.click(await screen.findByText('ZZZ'))

    expect(getGlobalModelPreference(TEAM_ID)?.modelName).toBe('zzz-remembered')
  })

  it('does not let its own guess install itself as the preference', async () => {
    // Otherwise whichever model sorted first would become "what you chose" just
    // by being displayed once, and no real choice could ever be seen again.
    const onChange = jest.fn()
    renderSelector({ value: null, onChange, teamId: TEAM_ID })

    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(getGlobalModelPreference(TEAM_ID)).toBeNull()
  })
})

describe('what each choice is remembered for', () => {
  beforeEach(() => {
    localStorage.clear()
    jest.clearAllMocks()
    ;(modelApis.getUnifiedModels as jest.Mock).mockResolvedValue({ data: MODELS })
  })

  it('does not let a wiki model become the summary model', async () => {
    // One slot per team meant the last choice made anywhere replaced every other,
    // so picking a strong model to read a repository silently became the model
    // that writes one-paragraph summaries, and vice versa.
    remember('zzz-remembered', 'wiki')
    const onChange = jest.fn()

    renderSelector({ value: null, onChange, teamId: TEAM_ID, scope: 'summary' })

    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(onChange.mock.calls[0][0].name).toBe('aaa-default')
  })

  it('keeps the conversation slot to itself', async () => {
    // The chat has always used the unscoped key and still does. A knowledge base
    // choice must not overwrite the model someone is talking to.
    const onChange = jest.fn()
    renderSelector({ value: null, onChange, teamId: TEAM_ID, scope: 'wiki' })
    await waitFor(() => expect(onChange).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId('model-select'))
    fireEvent.click(await screen.findByText('ZZZ'))

    expect(getGlobalModelPreference(TEAM_ID, undefined, 'wiki')?.modelName).toBe('zzz-remembered')
    expect(getGlobalModelPreference(TEAM_ID)).toBeNull()
  })
})
