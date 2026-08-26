import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { PluginCreatorResultCard } from './PluginCreatorResultCard'

describe('PluginCreatorResultCard', () => {
  test('offers view, share, and publish actions for a Task workspace result', () => {
    const onViewPlugin = vi.fn()
    const onShare = vi.fn()
    const onPublish = vi.fn()
    render(
      <PluginCreatorResultCard
        name="Cloud Notes"
        statusLabel="Saved in this conversation's Task workspace"
        onViewPlugin={onViewPlugin}
        onShare={onShare}
        onPublish={onPublish}
      />
    )

    fireEvent.click(screen.getByTestId('plugin-creator-view-plugin'))
    fireEvent.click(screen.getByTestId('plugin-creator-share-plugin'))
    fireEvent.click(screen.getByTestId('plugin-creator-publish-plugin'))

    expect(onViewPlugin).toHaveBeenCalledOnce()
    expect(onShare).toHaveBeenCalledOnce()
    expect(onPublish).toHaveBeenCalledOnce()
  })
})
