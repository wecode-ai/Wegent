import { preventSelectCloseFromStealingFocus } from '@/features/settings/utils/select-focus'

describe('preventSelectCloseFromStealingFocus', () => {
  it('preserves focus that already moved to a newer control', () => {
    const event = new Event('closeAutoFocus', { cancelable: true })
    const trigger = document.createElement('button')
    const content = document.createElement('div')
    const nextControl = document.createElement('button')
    document.body.append(trigger, content, nextControl)

    nextControl.focus()
    preventSelectCloseFromStealingFocus(event, document.activeElement, trigger, content)

    expect(event.defaultPrevented).toBe(true)
  })

  it('allows the select to restore focus while its content still owns focus', () => {
    const event = new Event('closeAutoFocus', { cancelable: true })
    const trigger = document.createElement('button')
    const content = document.createElement('div')
    const option = document.createElement('button')
    content.append(option)
    document.body.append(trigger, content)

    option.focus()
    preventSelectCloseFromStealingFocus(event, document.activeElement, trigger, content)

    expect(event.defaultPrevented).toBe(false)
  })

  it('allows focus that is already on the select trigger', () => {
    const event = new Event('closeAutoFocus', { cancelable: true })
    const trigger = document.createElement('button')
    const content = document.createElement('div')
    document.body.append(trigger, content)

    trigger.focus()
    preventSelectCloseFromStealingFocus(event, document.activeElement, trigger, content)

    expect(event.defaultPrevented).toBe(false)
  })

  it('allows the default restoration when no control owns focus', () => {
    const event = new Event('closeAutoFocus', { cancelable: true })

    preventSelectCloseFromStealingFocus(event, document.body, null, null)

    expect(event.defaultPrevented).toBe(false)
  })
})
