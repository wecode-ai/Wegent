import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { PluginCreatorResultCard } from './PluginCreatorResultCard'

describe('PluginCreatorResultCard', () => {
  test('offers view and unified share-and-publish actions for a Task workspace result', () => {
    const onViewPlugin = vi.fn()
    const onPublish = vi.fn()
    render(
      <PluginCreatorResultCard
        name="Cloud Notes"
        statusLabel="Saved in this conversation's Task workspace"
        onViewPlugin={onViewPlugin}
        onPublish={onPublish}
      />
    )

    fireEvent.click(screen.getByTestId('plugin-creator-view-plugin'))
    fireEvent.click(screen.getByTestId('plugin-creator-publish-plugin'))

    expect(onViewPlugin).toHaveBeenCalledOnce()
    expect(onPublish).toHaveBeenCalledOnce()
    expect(screen.getByTestId('plugin-creator-publish-plugin')).toHaveTextContent('分享与发布')
  })
})
