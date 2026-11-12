import { assertReleaseComposition } from './release-composition.mjs'
import { readConnectedApplicationPid } from './inspect-before-start.mjs'
import { assertMacosUpgradeIdentity } from './macos-upgrade-identity.mjs'
import { assertMacosStatusItem } from './macos-status-item.mjs'

export async function assertUpgradeComposition({
  control,
  root,
  version,
  compositions,
  macosIdentity,
  resultDir,
  inspectorPorts,
}) {
  await assertReleaseComposition(control, root, version, compositions)
  await assertMacosUpgradeIdentity(macosIdentity, root, resultDir, version)
  if (process.platform === 'darwin') {
    const pid = await readConnectedApplicationPid(control)
    await assertMacosStatusItem(control, pid, resultDir, version, inspectorPorts)
  }
}
