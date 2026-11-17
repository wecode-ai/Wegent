import assert from 'node:assert/strict'
import { waitForElementWidth } from './layout-metrics.mjs'

const selector = id => `[data-testid="${id}"]`
const channels = ['dingtalk', 'telegram', 'discord', 'weibo']

/** Inspect the initial empty-session menu in the existing real-Backend IM story. */
export async function verifyNarrowImMenu(control) {
  const previous = await control.command('setMainWindowSize', 'body', {
    value: JSON.stringify({ width: 760, height: 760 }),
  })
  try {
    await waitForElementWidth(
      control,
      'body',
      width => width > 0 && width <= 767,
      'IM menu narrow viewport'
    )
    await control.command('clickWhenEnabled', selector('stand-in-im-add-channels'))
    for (const channel of channels) {
      const item = `[role="menuitem"]${selector('stand-in-im-channel-' + channel)}`
      await control.command('waitFor', item, { visible: true })
      const boxes = JSON.parse(await control.command('getElementMetrics', item))
      assert.equal(boxes.length, 1, `The ${channel} menu entry must be unique`)
      assert.ok(
        boxes[0].width >= 44 && boxes[0].height >= 44,
        `Narrow ${channel} menu target: ${JSON.stringify(boxes)}`
      )
    }
    assert.equal(
      await control.command(
        'getElementCount',
        '[role="menuitem"][data-testid^="stand-in-im-channel-"]'
      ),
      String(channels.length),
      'The real empty-session fixture must offer all four known IM channels'
    )
    await control.command('clickWhenEnabled', selector('stand-in-im-add-channels'))
    await control.command(
      'waitFor',
      `[role="menuitem"]${selector('stand-in-im-channel-dingtalk')}`,
      { visible: false }
    )
  } finally {
    await control.command('setMainWindowSize', 'body', { value: previous })
  }
}
