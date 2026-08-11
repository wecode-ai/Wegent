import { expect, Page } from '@playwright/test'

export class ProviderNativeKnowledgePage {
  constructor(private readonly page: Page) {}

  async openPicker(): Promise<void> {
    await this.page.getByTestId('knowledge-context-button').click()
    await expect(this.page.getByTestId('knowledge-source-picker')).toBeVisible()
    const personalSource = this.page.getByTestId('knowledge-picker-source-personal')
    if (await personalSource.isVisible().catch(() => false)) {
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
      const documentNode = this.page.getByTestId(`knowledge-picker-document-node-${documentId}`)
      await expect(documentNode).toBeVisible()
      await documentNode.click()
    }
    await this.closePicker()
  }

  async sendMessage(message: string): Promise<void> {
    const input = this.page.getByTestId('message-input')
    await expect(input).toBeVisible()
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

  private async searchKnowledgeBase(
    knowledgeBaseId: number,
    knowledgeBaseName: string
  ): Promise<void> {
    const knowledgeBase = this.page.getByTestId(`knowledge-picker-kb-${knowledgeBaseId}`)
    if (await knowledgeBase.isVisible().catch(() => false)) return

    const search = this.page.getByTestId('context-selector-knowledge-search-input')
    await search.fill(knowledgeBaseName)
    await expect(knowledgeBase).toBeVisible()
  }

  private async closePicker(): Promise<void> {
    await this.page.keyboard.press('Escape')
    await expect(this.page.getByTestId('context-selector-popover')).toBeHidden()
  }

  private async expectIncludeSubfoldersControlHidden(): Promise<void> {
    const picker = this.page.getByTestId('knowledge-source-picker')
    await expect(picker.getByRole('checkbox')).toHaveCount(0)
    await expect(
      picker.getByText(/includeSubfolders|include subfolders|包含子文件夹|包含子目录/i)
    ).toHaveCount(0)
  }
}
