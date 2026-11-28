import assert from 'node:assert/strict'

export function videoSettingsFixtureHtml(title) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
    <h1>${title}</h1>
    <label>Video prompt <input id="prompt"></label>
    <button id="settings" popovertarget="video-settings">Video settings</button>
    <div id="video-settings" popover>
      <button id="portrait" aria-pressed="false">9:16</button>
    </div>
    <script>
      const settings = document.getElementById('settings')
      const portrait = document.getElementById('portrait')
      settings.addEventListener('click', () => {
        settings.dataset.clicks = Number(settings.dataset.clicks || 0) + 1
      })
      portrait.addEventListener('click', () => {
        portrait.dataset.clicks = Number(portrait.dataset.clicks || 0) + 1
        portrait.setAttribute('aria-pressed', 'true')
      })
    </script>`
}

function videoTool(callTool, parseToolJson) {
  return async (name, args) => {
    const result = parseToolJson(
      await callTool(name, name === 'browser_click' ? args : { ...args, timeoutMs: 5_000 })
    )
    assert.equal(
      result.ok,
      true,
      `${name} failed on the video settings page: ${JSON.stringify(result)}`
    )
    return result
  }
}

async function prepareVideoSettings(invoke, prompt) {
  await invoke('browser_wait_for', {
    condition: { expression: 'innerWidth > 1 && innerHeight > 1' },
  })
  await invoke('browser_fill', { selector: '#prompt', text: prompt })
}

async function selectPortrait(invoke, prompt) {
  await invoke('browser_wait_for', {
    condition: { selectorVisible: '#video-settings:popover-open' },
  })
  await invoke('browser_click', { selector: '#portrait' })
  const state = await invoke('browser_evaluate', {
    expression: `({
      prompt: document.querySelector('#prompt').value,
      open: document.querySelector('#video-settings:popover-open') !== null,
      selected: document.querySelector('#portrait').getAttribute('aria-pressed'),
      settingsClicks: Number(document.querySelector('#settings').dataset.clicks),
      optionClicks: Number(document.querySelector('#portrait').dataset.clicks)
    })`,
  })
  assert.deepEqual(state.value, {
    prompt,
    open: true,
    selected: 'true',
    settingsClicks: 1,
    optionClicks: 1,
  })
  return state.value
}

export async function verifyRestoredVideoSettings(callTool, parseToolJson) {
  const invoke = videoTool(callTool, parseToolJson)
  await prepareVideoSettings(invoke, 'Shot 10')
  await invoke('browser_click', { selector: '#settings' })
  return selectPortrait(invoke, 'Shot 10')
}

export async function verifyInterleavedVideoSettings({
  withTaskBrowser,
  parseToolJson,
  first,
  second,
  url,
  armTaskSwitch,
  assertSecondActive,
}) {
  assert.notEqual(first, second)
  return withTaskBrowser(first, async callFirst => {
    const a = videoTool(callFirst, parseToolJson)
    await a('browser_open', { url: url + '&task=first' })
    await prepareVideoSettings(a, 'First task')
    const { switched } = await armTaskSwitch()
    const clickResults = Promise.allSettled([a('browser_click', { selector: '#settings' })])
    await switched
    await assertSecondActive()
    return withTaskBrowser(second, async callSecond => {
      const b = videoTool(callSecond, parseToolJson)
      await b('browser_open', { url: url + '&task=second' })
      await prepareVideoSettings(b, 'Second task')
      await b('browser_click', { selector: '#settings' })
      const secondState = await selectPortrait(b, 'Second task')
      const [originalClick] = await clickResults
      if (originalClick.status === 'rejected') throw originalClick.reason
      const firstState = await selectPortrait(a, 'First task')
      await assertSecondActive()
      return { first: { label: first, ...firstState }, second: { label: second, ...secondState } }
    })
  })
}
