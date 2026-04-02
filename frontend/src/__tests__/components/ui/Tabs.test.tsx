import { render } from '@testing-library/react'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

describe('TabsContent', () => {
  it('forces inactive content to stay hidden even when flex classes are applied', () => {
    const { container } = render(
      <Tabs defaultValue="desktop">
        <TabsList>
          <TabsTrigger value="desktop">Desktop</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
        </TabsList>
        <TabsContent value="desktop" className="flex min-h-0 flex-1">
          Desktop content
        </TabsContent>
        <TabsContent value="files" className="flex min-h-0 flex-1">
          Files content
        </TabsContent>
      </Tabs>
    )

    const inactivePanel = container.querySelector('[role="tabpanel"][data-state="inactive"]')

    expect(inactivePanel).not.toBeNull()
    expect(inactivePanel).toHaveAttribute('data-state', 'inactive')
    expect(inactivePanel).toHaveAttribute('hidden')
    expect(inactivePanel).toHaveClass('data-[state=inactive]:hidden')
    expect(inactivePanel).toHaveClass('[&[hidden]]:hidden')
  })
})
