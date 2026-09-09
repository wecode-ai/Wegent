import { expect, Page } from '@playwright/test'

const MOBILE_VIEWPORT_MAX_WIDTH = 767

export class ProviderNativeKnowledgePage {
  constructor(private readonly page: Page) {}

  async openPicker(): Promise<void> {
    const contextButton = this.page.getByTestId('knowledge-context-button')
    const viewportWidth =
      this.page.viewportSize()?.width ?? (await this.page.evaluate(() => window.innerWidth))
    if (viewportWidth <= MOBILE_VIEWPORT_MAX_WIDTH) {
      const moreActionsButton = this.page.getByTestId('mobile-input-more-actions-button')
      await expect(moreActionsButton).toBeVisible()
      await moreActionsButton.click()
      await expect(this.page.getByTestId('mobile-input-more-actions-menu')).toBeVisible()
    }
    await expect(contextButton).toBeVisible()
    await contextButton.click()
    await expect(this.page.getByTestId('knowledge-source-picker')).toBeVisible()
    const personalSource = this.page.getByTestId('knowledge-picker-source-personal')
    const personalSourceIsActive = await personalSource.evaluate(element =>
      element.classList.contains('bg-primary/10')
    )
    if (!personalSourceIsActive) {
      await personalSource.click()
    }
  }

  async selectWholeKnowledgeBase(
    knowledgeBaseId: number,
    knowledgeBaseName: string
  ): Promise<void> {
    await this.openPicker()
    await this.searchKnowledgeBase(knowledgeBaseId, knowledgeBaseName)
    await this.page.getByTestId(`knowledge-picker-kb-select-${knowledgeBaseId}`).click()
    await this.closePicker()
  }

  async selectFolder(
    knowledgeBaseId: number,
    knowledgeBaseName: string,
    folderId: number
  ): Promise<void> {
    await this.openKnowledgeBase(knowledgeBaseId, knowledgeBaseName)
    const folderControl = this.page.getByTestId(`knowledge-picker-folder-scope-${folderId}`)
    await expect(folderControl).toBeVisible()
    await this.expectIncludeSubfoldersControlHidden()
    await folderControl.click()
    await this.closePicker()
  }

  async selectDocuments(
    knowledgeBaseId: number,
    knowledgeBaseName: string,
    documentIds: number[]
  ): Promise<void> {
    await this.openKnowledgeBase(knowledgeBaseId, knowledgeBaseName)
    for (const documentId of documentIds) {
      const documentNode = this.page.getByTestId(
        `knowledge-picker-document-node-document-${documentId}`
      )
      await expect(documentNode).toBeVisible()
      await documentNode.click()
    }
    await this.closePicker()
  }

  async selectDingTalkDocuments(nodeIds: string[]): Promise<void> {
    await this.openDingTalkSource('wikispace')
    await this.page.getByTestId('knowledge-picker-dingtalk-space-space-d').click()
    for (const nodeId of nodeIds) {
      const node = this.page.getByTestId(`knowledge-picker-dingtalk-node-wikispace-${nodeId}`)
      await expect(node).toBeVisible()
      await node.click()
    }
    await this.closePicker()
  }

  async selectDingTalkFolder(nodeId: string): Promise<void> {
    await this.openDingTalkSource('wikispace')
    await this.page.getByTestId('knowledge-picker-dingtalk-space-space-d').click()
    const control = this.page.getByTestId(
      `knowledge-picker-dingtalk-node-select-wikispace-${nodeId}`
    )
    await expect(control).toBeVisible()
    await control.click()
    await this.closePicker()
  }

  async selectDingTalkSpace(): Promise<void> {
    await this.openDingTalkSource('wikispace')
    await this.page.getByTestId('knowledge-picker-dingtalk-space-select-space-d').click()
    await this.closePicker()
  }

  async selectDingTalkMyDocument(nodeId: string): Promise<void> {
    await this.openDingTalkSource('docs')
    const node = this.page.getByTestId(`knowledge-picker-dingtalk-node-docs-${nodeId}`)
    await expect(node).toBeVisible()
    await node.click()
    await this.closePicker()
  }

  async sendMessage(message: string): Promise<void> {
    const input = this.page.getByTestId('message-input')
    await expect(input).toBeVisible()
    await expect(input).toHaveAttribute('contenteditable', 'true')
    await input.click()
    await input.pressSequentially(message)
    const sendButton = this.page.getByTestId('send-button')
    await expect(sendButton).toBeEnabled()
    await sendButton.click()
  }

  async waitForTaskId(): Promise<number> {
    await expect
      .poll(() => new URL(this.page.url()).searchParams.get('taskId'), {
        message: 'Chat URL should contain taskId after sending a message',
        timeout: 15000,
      })
      .not.toBeNull()
    return Number(new URL(this.page.url()).searchParams.get('taskId'))
  }

  private async openKnowledgeBase(
    knowledgeBaseId: number,
    knowledgeBaseName: string
  ): Promise<void> {
    await this.openPicker()
    await this.searchKnowledgeBase(knowledgeBaseId, knowledgeBaseName)
    await this.page.getByTestId(`knowledge-picker-kb-${knowledgeBaseId}`).click()
  }

  private async openDingTalkSource(source: 'docs' | 'wikispace'): Promise<void> {
    await this.openPicker()
    await this.page.getByTestId('knowledge-picker-dingtalk-parent').click()
    const sourceButton = this.page.getByTestId(`knowledge-picker-dingtalk-${source}`)
    await expect(sourceButton).toBeVisible()
    await sourceButton.click()
  }

  private async searchKnowledgeBase(
    knowledgeBaseId: number,
    knowledgeBaseName: string
  ): Promise<void> {
    const knowledgeBase = this.page.getByTestId(`knowledge-picker-kb-${knowledgeBaseId}`)
    if (await knowledgeBase.isVisible()) return

    const search = this.page.getByTestId('context-selector-knowledge-search-input')
    await search.fill(knowledgeBaseName)
    await expect(knowledgeBase).toBeVisible()
  }

  async closePicker(): Promise<void> {
    await this.page.keyboard.press('Escape')
    await expect(this.page.getByTestId('context-selector-popover')).toBeHidden()
    await expect(this.page.getByTestId('context-selector-drawer')).toBeHidden()
  }

  private async expectIncludeSubfoldersControlHidden(): Promise<void> {
    const picker = this.page.getByTestId('knowledge-source-picker')
    const includeSubfoldersLabel = /includeSubfolders|include subfolders|包含子文件夹|包含子目录/i
    await expect(picker.getByRole('checkbox', { name: includeSubfoldersLabel })).toHaveCount(0)
    await expect(picker.getByText(includeSubfoldersLabel)).toHaveCount(0)
  }
}
