import assert from 'node:assert/strict'
import { test } from 'vitest'
import { openAboutSettings } from '../e2e/desktop/modules/app-update-navigation.mjs'

const selector = id => `[data-testid="${id}"]`

function navigation(initialPage, renderAbout = true) {
  let page = initialPage
  let menuOpen = false
  const clicked = []
  return {
    clicked,
    async command(name, target) {
      if (name === 'getElementCount') {
        assert.equal(target, selector('wework-settings-page'))
        return page === 'workbench' ? '0' : '1'
      }
      if (name === 'waitFor') {
        assert.equal(target, selector('about-settings-page'))
        if (page !== 'about' || !renderAbout) throw new Error('About page did not render')
        return
      }
      assert.equal(name, 'clickWhenEnabled')
      clicked.push(target)
      if (target === selector('settings-button')) {
        assert.equal(page, 'workbench', 'The account entry is absent in settings')
        menuOpen = !menuOpen
      } else if (target === selector('about-menu-button')) {
        assert.equal(menuOpen, true)
        page = 'about'
        menuOpen = false
      } else {
        assert.equal(target, selector('settings-nav-about'))
        assert.notEqual(page, 'workbench', 'The settings sidebar is absent in the workbench')
        page = 'about'
      }
    },
  }
}

test('rollback protection followed by re-upgrade can enter About twice', async () => {
  const control = navigation('workbench')
  await openAboutSettings(control)
  await openAboutSettings(control)
  assert.deepEqual(control.clicked, [
    selector('settings-button'),
    selector('about-menu-button'),
    selector('settings-nav-about'),
  ])
})

for (const page of ['general', 'about']) {
  test(`opens About from the existing ${page} settings page`, async () => {
    const control = navigation(page)
    await openAboutSettings(control)
    assert.deepEqual(control.clicked, [selector('settings-nav-about')])
  })
}

test('missing About content retains its failure', async () => {
  const control = navigation('workbench', false)
  await assert.rejects(openAboutSettings(control), /About page did not render/)
  assert.deepEqual(control.clicked, [selector('settings-button'), selector('about-menu-button')])
})
