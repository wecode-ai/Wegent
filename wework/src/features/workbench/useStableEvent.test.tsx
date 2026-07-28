import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLayoutEffect, useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { useStableEvent } from './useStableEvent'

function StableEventProbe({ onCall }: { onCall: (value: string) => void }) {
  const [value, setValue] = useState('initial')
  const stableEvent = useStableEvent(() => onCall(value))

  useLayoutEffect(() => {
    if (value === 'updated') stableEvent()
  }, [stableEvent, value])

  return (
    <button
      type="button"
      data-testid="stable-event-update-button"
      onClick={() => setValue('updated')}
    >
      update
    </button>
  )
}

describe('useStableEvent', () => {
  test('uses the latest committed handler before layout effects can dispatch events', async () => {
    const onCall = vi.fn()
    render(<StableEventProbe onCall={onCall} />)

    await userEvent.click(screen.getByRole('button', { name: 'update' }))

    expect(onCall).toHaveBeenCalledWith('updated')
  })
})
