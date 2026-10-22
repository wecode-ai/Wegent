import { join } from 'node:path'
import { mkdir, writeFile, readdir } from 'node:fs/promises'
import {
  VISUALIZATION_MARKER,
  COMPOSER_SELECTOR,
  VISUALIZATION_PROMPT,
  ACTIVE_WORKBENCH_SELECTOR,
  waitForVisualizationBlob,
  VISUALIZATION_TITLE,
  openNewChatWithE2EModel,
  GENERATED_IMAGE_PROMPT,
  ASSISTANT_CONTENT_SELECTOR,
  GENERATED_IMAGE_COMPLETION,
  expandCompletedProcessing,
  PROCESS_TEXT_SELECTOR,
  RECLASSIFIED_COMMENTARY_PROMPT,
  RECLASSIFIED_COMMENTARY_TEXT,
  RECLASSIFIED_COMMENTARY_FINAL,
} from './streaming-text-fixture.mjs'
import assert from 'node:assert/strict'

export function createStreamingContentChecks({
  workspacePath,
  uiTimeoutMs,
  capture,
  reclassifiedCommentaryFollowUpReceived,
  releaseReclassifiedCommentaryFinal,
}) {
  const verifyContent = async control => {
    const visualizationDirectory = join(workspacePath, 'visualizations')
    const visualizationPath = join(visualizationDirectory, 'absolute-reference.html')
    await mkdir(visualizationDirectory, { recursive: true })
    await writeFile(
      visualizationPath,
      `<section style="padding:24px;font:600 18px system-ui;color:#2563eb">${VISUALIZATION_MARKER}</section>`,
      'utf8'
    )
    await control.command('fill', COMPOSER_SELECTOR, { value: VISUALIZATION_PROMPT })
    await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
    const visualizationSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="codex-inline-visualization"]`
    const visualizationFrameSelector = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="codex-inline-visualization-frame"]`
    await control.command('waitFor', visualizationFrameSelector, { timeoutMs: uiTimeoutMs })
    await waitForVisualizationBlob(control, visualizationFrameSelector, uiTimeoutMs)
    assert.equal(
      await control.command('getAttribute', visualizationSelector, {
        value: 'data-visualization-mode',
      }),
      'wide',
      'The visualize content reference did not preserve wide mode'
    )
    assert.equal(
      await control.command('getAttribute', visualizationFrameSelector, { value: 'title' }),
      VISUALIZATION_TITLE,
      'The visualize content reference did not preserve its title'
    )
    assert.equal(
      await control.command('getAttribute', visualizationFrameSelector, { value: 'sandbox' }),
      'allow-scripts',
      'The visualization iframe lost its sandbox'
    )
    const visualizationSnapshot = JSON.parse(
      await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
    )
    assert.ok(
      !visualizationSnapshot.text.includes('visualize'),
      'The raw visualize content reference remained visible'
    )
    await capture(control, 'streaming-text-00-absolute-visualization.png')
    if (process.env.WEWORK_E2E_VISUALIZATION_ONLY === 'true') {
      return
    }

    await openNewChatWithE2EModel(control, uiTimeoutMs)
    await control.command('fill', COMPOSER_SELECTOR, { value: GENERATED_IMAGE_PROMPT })
    await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
    await control.command('waitFor', '[data-testid="generated-image"]', {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
      text: GENERATED_IMAGE_COMPLETION,
      timeoutMs: uiTimeoutMs,
    })
    assert.match(
      await control.command('getAttribute', '[data-testid="generated-image"]', {
        value: 'src',
      }),
      /^blob:/,
      'The generated image was not loaded from its workspace artifact'
    )
    const generatedImageDirectory = join(workspacePath, 'outputs', 'generated-images')
    assert.ok(
      (await readdir(generatedImageDirectory)).some(name => name.endsWith('.png')),
      'The Executor did not materialize the generated image in the task workspace'
    )
    await expandCompletedProcessing(control, uiTimeoutMs)
    const generatedImageSnapshot = JSON.parse(
      await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
    )
    assert.ok(
      generatedImageSnapshot.text.includes('图片已生成'),
      'The generated image tool did not expose its completed status'
    )
    assert.equal(
      generatedImageSnapshot.text.includes('工具未返回内容'),
      false,
      'The generated image tool exposed an empty generic tool result'
    )
    await capture(control, 'streaming-text-00-generated-image.png')
    if (process.env.WEWORK_E2E_GENERATED_IMAGE_ONLY === 'true') {
      return
    }

    const assistantCountBeforeReclassifiedCommentary = Number(
      await control.command('getElementCount', ASSISTANT_CONTENT_SELECTOR)
    )
    const processTextCountBeforeReclassifiedCommentary = Number(
      await control.command('getElementCount', PROCESS_TEXT_SELECTOR)
    )
    await control.command('fill', COMPOSER_SELECTOR, {
      value: RECLASSIFIED_COMMENTARY_PROMPT,
    })
    await control.command('press', COMPOSER_SELECTOR, { key: 'Enter' })
    try {
      await Promise.race([
        reclassifiedCommentaryFollowUpReceived,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('The reclassified-commentary follow-up was not received')),
            uiTimeoutMs
          )
        ),
      ])
    } catch (error) {
      releaseReclassifiedCommentaryFinal()
      throw error
    }
    await control.command('waitFor', PROCESS_TEXT_SELECTOR, {
      text: RECLASSIFIED_COMMENTARY_TEXT,
      timeoutMs: uiTimeoutMs,
    })
    assert.equal(
      Number(await control.command('getElementCount', PROCESS_TEXT_SELECTOR)),
      processTextCountBeforeReclassifiedCommentary + 1,
      'Reclassified commentary did not add exactly one process block'
    )
    assert.equal(
      Number(await control.command('getElementCount', ASSISTANT_CONTENT_SELECTOR)),
      assistantCountBeforeReclassifiedCommentary,
      'Reclassified commentary remained visible as final assistant content'
    )
    const reclassifiedRunningSnapshot = JSON.parse(
      await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
    )
    assert.ok(
      reclassifiedRunningSnapshot.testIds.includes('pause-response-button'),
      'The turn stopped after commentary was reclassified even though the real final was pending'
    )
    releaseReclassifiedCommentaryFinal()
    await control.command('waitFor', ASSISTANT_CONTENT_SELECTOR, {
      text: RECLASSIFIED_COMMENTARY_FINAL,
      timeoutMs: uiTimeoutMs,
    })
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
      { stableMs: 750, timeoutMs: uiTimeoutMs }
    )
    const reclassifiedCompletedSnapshot = JSON.parse(
      await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
    )
    assert.equal(
      Number(await control.command('getElementCount', ASSISTANT_CONTENT_SELECTOR)),
      assistantCountBeforeReclassifiedCommentary + 1,
      'The real final answer did not add exactly one assistant response'
    )
    assert.ok(
      !reclassifiedCompletedSnapshot.testIds.includes('pause-response-button'),
      'The turn remained active after the real final completed'
    )
  }
  return { verifyContent }
}
