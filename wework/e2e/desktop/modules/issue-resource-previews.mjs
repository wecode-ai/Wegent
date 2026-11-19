import assert from 'node:assert/strict'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const DIALOG = '[data-testid="cloud-file-preview-dialog"]'

/** Extend the existing real cloud attachment checkpoint without another environment bootstrap. */
export function createIssueResourceCoverage({ requestJson, assertImageDecoded }) {
  let project
  let issue
  let image
  let report
  let upload
  let imageBytes

  return {
    async prepare({ cloud, project: targetProject, issue: targetIssue, attachment }) {
      project = targetProject
      issue = targetIssue
      image = attachment
      const markdown = `# Issue resource document\n\n**Rendered Markdown**\n\n![Screenshot](wegent://attachments/${image.id})\n\n[Source](./resource-notes.txt)`
      const sourceImage = await fetch(
        `${cloud.backendUrl}/api/v1/loop-item-attachments/${image.id}/content`,
        {
          headers: { Authorization: `Bearer ${cloud.authToken}` },
        }
      )
      assert.equal(sourceImage.status, 200)
      imageBytes = await sourceImage.arrayBuffer()
      upload = async (filename, content, type) => {
        const form = new FormData()
        form.set('file', new Blob([content], { type }), filename)
        const response = await fetch(
          `${cloud.backendUrl}/api/v1/loop-items/${issue.id}/attachments`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${cloud.authToken}` },
            body: form,
          }
        )
        assert.equal(
          response.status,
          201,
          `Resource upload failed: ${await response.clone().text()}`
        )
        return response.json()
      }
      report = await upload('resource-report.md', markdown, 'application/octet-stream')
      await upload('resource-notes.txt', 'Issue resource text attachment', 'text/plain')
      const comments = [
        `Unified Issue resource regression\n\n![Screenshot](wegent://attachments/${image.id})`,
        `![${image.display_name}](/home/ubuntu/output/generated-screenshot.png)\n\n[resource-report.md](/home/ubuntu/output/generated-report.md)\n\n[resource-notes.txt](./resource-notes.txt)`,
        '![missing-resource.png](/home/ubuntu/missing-resource.png)',
      ]
      for (const body of comments)
        await requestJson(
          `/api/v1/cloud-projects/${project.id}/loop-items/${issue.id}/activity-comments`,
          {
            method: 'POST',
            body: JSON.stringify({ body }),
          }
        )
    },
    async verify(control) {
      await control.command('openWeworkScheme', 'body', {
        value: `wework://boards/${project.id}/issues/${issue.id}`,
      })
      const activity = `${CONTENT} [data-testid="cloud-task-activity-${issue.id}"]`
      await control.command('waitFor', activity, { text: 'Unified Issue resource regression' })
      for (const alt of ['Screenshot', image.display_name]) {
        const selector = `${activity} [data-testid="assistant-markdown-image"][alt="${alt}"]`
        await control.command('waitFor', selector)
        await control.command('scrollIntoView', selector)
        await assertImageDecoded(control, selector)
      }
      const missing = `${activity} [data-testid="assistant-markdown-image-error"]`
      await control.command('waitFor', missing, { text: 'missing-resource.png' })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `${missing} [data-testid="assistant-markdown-image-retry"]`
          )
        ),
        1
      )
      await upload('missing-resource.png', imageBytes, 'image/png')
      await control.command('click', `${missing} [data-testid="assistant-markdown-image-retry"]`)
      const recoveredImage = `${activity} [data-testid="assistant-markdown-image"][alt="missing-resource.png"]`
      await control.command('waitFor', recoveredImage)
      await control.command('scrollIntoView', recoveredImage)
      await assertImageDecoded(control, recoveredImage)
      const reportLink = `${activity} [data-testid="issue-comment-file-attachment"][data-resource-name="resource-report.md"]`
      await control.command('scrollIntoView', reportLink)
      await control.command('click', reportLink)
      const markdown = `${DIALOG} [data-testid="cloud-file-preview-markdown"]`
      await control.command('waitFor', `${markdown} h1`, { text: 'Issue resource document' })
      await control.command('waitFor', `${markdown} strong`, { text: 'Rendered Markdown' })
      await assertImageDecoded(control, `${markdown} [data-testid="assistant-markdown-image"]`)
      await control.command('click', `${markdown} [data-testid="issue-comment-file-attachment"]`)
      await control.command('waitFor', `${DIALOG} [data-testid="cloud-file-preview-text"]`, {
        text: 'Issue resource text attachment',
      })
      await control.command('click', `${DIALOG} [data-testid="cloud-file-preview-close"]`)
      await control.command('waitFor', DIALOG, { visible: false })
      const imageButton = `${activity} [data-testid="assistant-markdown-image-open"]:has(img[alt="Screenshot"])`
      await control.command('scrollIntoView', imageButton)
      await control.command('click', imageButton)
      await assertImageDecoded(control, `${DIALOG} [data-testid="cloud-file-preview-image"]`)
      await control.command('click', `${DIALOG} [data-testid="cloud-file-preview-close"]`)
      await control.command('waitFor', DIALOG, { visible: false })
      assert.ok(report.id, 'The Markdown fixture must remain an uploaded Issue attachment')
    },
  }
}
