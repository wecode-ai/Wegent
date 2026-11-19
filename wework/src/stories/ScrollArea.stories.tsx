import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  ScrollArea,
  ScrollAreaViewport,
  ScrollAreaContent,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaCorner,
  ScrollAreaScrollToEnd,
} from '@wegent/collaboration/controls'
import { useTranslation } from '@/hooks/useTranslation'
const meta = { title: 'Controls/ScrollArea', component: ScrollArea } satisfies Meta<
  typeof ScrollArea
>
export default meta
type Story = StoryObj<Record<string, never>>
function Example({ empty = false, horizontal = false }) {
  const { t } = useTranslation('componentCatalog')
  return (
    <ScrollArea className="relative h-60 max-w-lg rounded-lg border border-border">
      <ScrollAreaViewport
        aria-label={t('scrollRegion')}
        tabIndex={0}
        data-testid="catalog-scroll-viewport"
      >
        <ScrollAreaContent className={horizontal ? 'w-max' : 'p-3'}>
          {empty ? (
            <p>{t('empty')}</p>
          ) : (
            Array.from({ length: 40 }, (_, i) => (
              <p key={i} className="min-h-11 whitespace-nowrap px-3 py-2">
                {i + 1}. {horizontal ? t('long').repeat(3) : t('title')}
              </p>
            ))
          )}
        </ScrollAreaContent>
      </ScrollAreaViewport>
      <ScrollAreaScrollbar orientation="vertical">
        <ScrollAreaThumb />
      </ScrollAreaScrollbar>
      {horizontal && (
        <ScrollAreaScrollbar orientation="horizontal">
          <ScrollAreaThumb />
        </ScrollAreaScrollbar>
      )}
      <ScrollAreaCorner />
      <ScrollAreaScrollToEnd
        aria-label={t('scrollToEnd')}
        className="absolute bottom-2 right-4 min-h-11 rounded-lg bg-surface px-3 text-sm shadow"
        data-testid="catalog-scroll-to-end"
      >
        ↓
      </ScrollAreaScrollToEnd>
    </ScrollArea>
  )
}
export const Vertical: Story = { render: () => <Example /> }
export const BothAxes: Story = { render: () => <Example horizontal /> }
export const Empty: Story = { render: () => <Example empty /> }
