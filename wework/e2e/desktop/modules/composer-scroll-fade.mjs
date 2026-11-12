import { ACTIVE_WORKBENCH_SELECTOR, DEFAULT_STEP_TIMEOUT_MS, assert } from './shared.mjs'

function composerScrollSelector() {
  return `${ACTIVE_WORKBENCH_SELECTOR} [data-composer-scroll-container]:has([data-testid="chat-message-input"])`
}

async function readComposerFade(control, composerSelector) {
  const scrollSelector = composerScrollSelector()
  const viewports = JSON.parse(await control.command('getElementMetrics', scrollSelector))
  assert.equal(viewports.length, 1, 'The active rich composer must use one content viewport')
  const style = property =>
    control.command('getComputedStyleValue', scrollSelector, { value: property })
  return {
    ...viewports[0],
    value: await control.command('getValue', composerSelector),
    mask: await style('mask-image'),
    topFade: Number.parseFloat(await style('--composer-scroll-fade-top')),
    bottomFade: Number.parseFloat(await style('--composer-scroll-fade-bottom')),
  }
}

async function waitForComposerFade(control, composerSelector, predicate, description) {
  const startedAt = Date.now()
  let observed
  while (Date.now() - startedAt < DEFAULT_STEP_TIMEOUT_MS) {
    observed = await readComposerFade(control, composerSelector)
    if (predicate(observed)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`${description}: ${JSON.stringify(observed)}`)
}

function isUnmasked(state, value) {
  return (
    state.value === value &&
    state.clientHeight > 0 &&
    state.scrollHeight <= state.clientHeight + 1 &&
    state.mask === 'none' &&
    state.topFade === 0 &&
    state.bottomFade === 0
  )
}

export async function verifyComposerFadeBeforeSubmit(control, composerSelector, draft) {
  await control.command('fill', composerSelector, { value: draft })
  await control.command('scrollToRatioAsUser', composerScrollSelector(), { value: '1' })
  await waitForComposerFade(
    control,
    composerSelector,
    state =>
      state.value === draft &&
      state.scrollHeight > state.clientHeight + 1 &&
      state.scrollTop > 0 &&
      state.scrollHeight - state.clientHeight - state.scrollTop <= 1 &&
      state.mask.includes('linear-gradient') &&
      state.topFade > 0 &&
      state.bottomFade === 0,
    'A long draft scrolled to the bottom must fade only its hidden top edge'
  )
}

export async function verifyComposerFadeAfterSubmit(control, composerSelector) {
  await waitForComposerFade(
    control,
    composerSelector,
    state => isUnmasked(state, ''),
    'Sending the long draft must clear its text and remove the scroll mask'
  )
  const singleLine = 'Composer fade reset gjpqy'
  try {
    await control.command('fill', composerSelector, { value: singleLine })
    await waitForComposerFade(
      control,
      composerSelector,
      state => isUnmasked(state, singleLine),
      'The next single-line draft must remain completely unmasked'
    )
  } finally {
    await control.command('fill', composerSelector, { value: '' })
  }
}
