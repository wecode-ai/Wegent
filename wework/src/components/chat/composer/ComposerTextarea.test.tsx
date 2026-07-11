import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef, useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import type { LocalDeviceSkill } from '@/types/api'
import { ComposerTextarea } from './ComposerTextarea'

const GMAIL_SKILL: LocalDeviceSkill = {
  name: 'gmail',
  description: 'Manage Gmail',
  path: '/tmp/gmail/SKILL.md',
  source: 'codex',
}
const GMAIL_REFERENCE = '[$gmail](/tmp/gmail/SKILL.md)'

describe('ComposerTextarea', () => {
  test('consumes the Enter that selects a skill without adding a line break', async () => {
    const textareaRef = createRef<HTMLElement>()
    const onChange = vi.fn()
    const onOpenSkillFile = vi.fn()

    function Harness() {
      const [value, setValue] = useState('')
      return (
        <ComposerTextarea
          value={value}
          onChange={nextValue => {
            onChange(nextValue)
            setValue(nextValue)
          }}
          onSubmit={vi.fn()}
          canSend={false}
          placeholder="Message"
          rows={2}
          textareaRef={textareaRef}
          className="min-h-12"
          onOpenSkillFile={onOpenSkillFile}
          onListLocalSkills={async () => [GMAIL_SKILL]}
        />
      )
    }

    render(<Harness />)
    const editor = screen.getByTestId('chat-message-input') as HTMLElement & { value: string }

    act(() => {
      editor.value = '$gmail'
      editor.focus()
    })
    await screen.findByTestId('local-skill-option-gmail')

    expect(
      fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', keyCode: 13, charCode: 13 })
    ).toBe(false)

    await waitFor(() => expect(editor.value).toBe(`${GMAIL_REFERENCE} `))
    expect(editor.value).not.toContain('\n')
    expect(onChange).toHaveBeenLastCalledWith(`${GMAIL_REFERENCE} `)

    fireEvent.mouseDown(screen.getByTestId('local-skill-chip-gmail'), { button: 0 })
    expect(onOpenSkillFile).toHaveBeenCalledWith('/tmp/gmail/SKILL.md')
  })
})
