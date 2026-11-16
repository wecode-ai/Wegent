import assert from 'node:assert/strict'
import { waitForUpdatePreparation } from './update-preparation-progress.mjs'

/** Start the final real transfer only after checking each stale-offer recovery boundary. */
export async function startRefreshedAppUpdate(
  control,
  { staleVersion, targetVersion, requests, setOffer, manifestPath }
) {
  const button = '[data-testid="about-check-update-button"]'
  const status = '[data-testid="about-update-status"]'
  const progress = async () => JSON.parse(await control.command('getAppUpdateProgress', 'body'))
  const alreadyAvailable = (await control.command('clickWhenEnabled', button)).includes(
    staleVersion
  )
  if (!alreadyAvailable) {
    await control.command('waitFor', status, { text: staleVersion })
    await control.command('clickWhenEnabled', button)
  }
  await assert.rejects(waitForUpdatePreparation(progress), /Release download failed: HTTP 503/)

  let start = requests.length
  setOffer('refresh-failed')
  await control.command('clickWhenEnabled', button)
  await assert.rejects(
    waitForUpdatePreparation(progress),
    /Verified upgrade catalog request failed: HTTP 503/
  )
  assert.deepEqual(
    requests.slice(start).map(request => request.path),
    [manifestPath],
    'A failed refresh must not download the stale archive'
  )

  start = requests.length
  setOffer('withdrawn')
  await control.command('clickWhenEnabled', button)
  await control.command('waitFor', status, { text: '已是最新版本' })
  assert.deepEqual(
    requests.slice(start).map(request => request.path),
    [manifestPath],
    'Withdrawal must clear the stale offer without another archive request'
  )
  assert.equal((await progress()).phase, 'upToDate')
  assert.equal((await progress()).update, null)

  setOffer('unavailable')
  await control.command('clickWhenEnabled', button)
  await control.command('waitFor', status, { text: staleVersion })
  await control.command('clickWhenEnabled', button)
  await assert.rejects(waitForUpdatePreparation(progress), /Release download failed: HTTP 503/)
  start = requests.length
  setOffer('target')
  await control.command('clickWhenEnabled', button)
  await control.command('waitFor', button, { text: targetVersion })
  const accepted = await progress()
  assert.equal(
    accepted.update.version,
    targetVersion,
    'The accepted update must identify the refreshed real target'
  )
  assert.equal(
    requests[start]?.path,
    manifestPath,
    'Retry must refresh the catalog before starting the real transfer'
  )
  assert.equal(
    requests.filter(request => request.path === '/unavailable-release.tar.gz').length,
    2,
    'Only the two deliberately failed offers may request the unavailable archive'
  )
}
