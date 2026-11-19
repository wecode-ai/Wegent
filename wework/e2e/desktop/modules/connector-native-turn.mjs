import { until } from './plugin-regression-fixture.mjs'

export async function waitForConnectorNativeTurn(
  control,
  { completion, replySent, modelResponseTimeoutMs, uiTimeoutMs }
) {
  await until(
    replySent,
    Boolean,
    'The connector native turn did not return its successful upstream result',
    modelResponseTimeoutMs
  )
  await control.command('waitFor', '[data-testid="message-assistant"]', {
    text: completion,
    timeoutMs: uiTimeoutMs,
  })
}
