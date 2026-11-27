import { expect, it, vi } from 'vitest'
import { createBufferedComposerModel } from './bufferedComposerModel'

it.each([true, false])(
  'keeps the prefilled Issue reference cleared until submission settles (accepted: %s)',
  async accepted => {
    const reference = '[$PROJECT-42 · Follow up](wework-issue://project/issue)'
    const message = `${reference} Investigate the missing update`
    const submission = Promise.withResolvers<boolean>()
    const input = {
      value: reference,
      scopeKey: 'issue-task',
      clearOnSubmit: true,
      onChange: vi.fn(),
      onSubmit: vi.fn(() => submission.promise),
    }
    const model = createBufferedComposerModel(input)
    model.setDraft(message)
    expect(model.preview(input)).toBe(message)

    model.handleSubmit()

    expect(input.onSubmit).toHaveBeenCalledWith(message)
    expect(input.onChange).toHaveBeenLastCalledWith('')
    expect(model.preview(input)).toBe('')
    const acknowledgedInput = { ...input, value: '' }
    expect(model.preview(acknowledgedInput)).toBe('')

    submission.resolve(accepted)
    await submission.promise

    expect(model.preview(input)).toBe(accepted ? '' : message)
    expect(model.preview(acknowledgedInput)).toBe(accepted ? '' : message)
  }
)
