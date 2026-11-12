import assert from 'node:assert/strict'

export async function verifyFirstUsePageLoading(control) {
  const active = '[data-workspace-tab-content][aria-hidden="false"]'
  const page = `${active} [data-testid="sites-workspace"]`
  const loading = `${active} [data-testid="dsh-route-loading"]`
  const content = `${loading}, ${page}`
  const entry = `${active} [data-testid="sites-button"]`

  // The startup checkpoint has not visited Applications in this renderer.
  // Use real bundled assets; a fast load may already have reached the page.
  await control.command('waitFor', entry, { visible: true })
  await control.command('click', entry)
  await control.command('waitFor', content, { visible: true })
  const firstText = await control.command('getText', content, { visible: true })
  assert.ok(firstText.trim(), 'First-use Applications content was blank while loading')
  await control.command('waitFor', page, { visible: true })
  assert.equal(
    Number(await control.command('getElementCount', loading)),
    0,
    'The loading state remained after Applications became ready'
  )

  await control.command('navigate', 'body', { value: '/' })
  await control.command('waitFor', `${active} [data-testid="desktop-empty-composer-frame"]`)
  await control.command('click', `${active} [data-testid="sites-button"]`)
  await control.command('waitFor', page, { visible: true })
  assert.equal(
    Number(await control.command('getElementCount', loading)),
    0,
    'Reentering a loaded page did not reuse the module cache'
  )
  await control.command('navigate', 'body', { value: '/' })
  await control.command('waitFor', `${active} [data-testid="desktop-empty-composer-frame"]`)
}
