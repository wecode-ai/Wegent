import { assert } from './shared.mjs'
import { waitForPersistedComposerInput } from './workspace-flows.mjs'

async function verifyEditedHeadingTail(control, composerSelector) {
  await control.command('fill', composerSelector, { value: '# Heading' })
  assert.equal(
    Number(await control.command('getElementCount', `${composerSelector} > h1`)),
    1,
    'The draft must use a rich heading with an editable trailing paragraph'
  )
  await control.command('setSelectionOffset', `${composerSelector} > p:last-child`, { value: '0' })
  await control.command('pasteText', composerSelector, { value: 'abc' })
  await control.command('setSelectionOffset', `${composerSelector} > p:last-child`, { value: '0' })
  await control.command('nativePress', composerSelector, { key: 'Shift+Enter' })
  const expected = '# Heading\n\n\nabc'
  await waitForPersistedComposerInput(
    control,
    expected,
    'The edited heading tail did not persist its new empty paragraph'
  )
  assert.equal(
    await control.command('getValue', composerSelector),
    expected,
    'A user-created empty paragraph must be included in the acknowledged draft'
  )
  assert.equal(
    Number(await control.command('getElementCount', `${composerSelector} > p`)),
    2,
    'Splitting the edited heading tail must produce two paragraphs'
  )
  assert.equal(
    Number(await control.command('getSelectionOffset', `${composerSelector} > p:last-child`)),
    0,
    'Splitting the edited heading tail must leave the caret before its text'
  )
}

export async function verifyComposerMarkdownDraftAcknowledgement(control, composerSelector) {
  const markdown = '**Composer Markdown draft acknowledgement**'
  const multiline = `${markdown}\n\n`
  try {
    await control.command('fill', composerSelector, { value: markdown })
    assert.equal(
      Number(await control.command('getElementCount', `${composerSelector} strong`)),
      1,
      'The draft must render Markdown formatting before testing its line break'
    )
    await control.command('nativePress', composerSelector, { key: 'Shift+Enter' })
    await waitForPersistedComposerInput(
      control,
      multiline,
      'The parent did not acknowledge the Markdown draft with its new line'
    )
    assert.equal(
      await control.command('getValue', composerSelector),
      multiline,
      'Acknowledging a Markdown draft must preserve its trailing line break'
    )
    assert.equal(
      Number(await control.command('getElementCount', `${composerSelector} > p`)),
      2,
      'Acknowledging the draft must preserve the new empty paragraph'
    )
    assert.equal(
      Number(await control.command('getSelectionOffset', `${composerSelector} > p:last-child`)),
      0,
      'The caret must remain in the new empty paragraph after acknowledgement'
    )
    await verifyEditedHeadingTail(control, composerSelector)
  } catch (error) {
    console.error(
      '[composer-markdown-failure]',
      JSON.stringify({
        value: await control.command('getValue', composerSelector).catch(() => null),
        snapshot: await control.command('snapshot', composerSelector).catch(() => null),
        caret: await control
          .command('getSelectionOffset', `${composerSelector} > p:last-child`)
          .catch(() => null),
      })
    )
    throw error
  } finally {
    await control.command('fill', composerSelector, { value: '' })
    await waitForPersistedComposerInput(control, '', 'The Markdown test draft was not cleared')
  }
}
