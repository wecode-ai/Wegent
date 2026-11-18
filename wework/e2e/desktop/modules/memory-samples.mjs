import assert from 'node:assert/strict'

export async function captureMemorySample(control, phase) {
  const snapshot = JSON.parse(await control.command('performanceSnapshot', 'body'))
  const webContent = snapshot.processMemory.groups.find(
    group => group.group === 'webkit-webcontent'
  )
  assert.ok(webContent, 'The Wework WebContent process was missing from the memory snapshot')
  return {
    phase,
    exitedProcesses: snapshot.processMemory.exited_processes,
    timestamp: snapshot.timestamp,
    domNodeCount: snapshot.domNodeCount,
    assistantDom: snapshot.assistantDom,
    activeRuntimeAssistant: snapshot.activeRuntimeAssistant,
    usedJSHeapSize: snapshot.rendererHeap?.usedSize ?? null,
    totalJSHeapSize: snapshot.rendererHeap?.totalSize ?? null,
    rssKiB: webContent.rss_kib,
    physicalFootprintKiB: webContent.physical_footprint_kib,
    pids: webContent.pids,
  }
}

export async function captureTotalMemorySample(control, phase) {
  const snapshot = JSON.parse(await control.command('performanceSnapshot', 'body'))
  return {
    phase,
    exitedProcesses: snapshot.processMemory.exited_processes,
    timestamp: snapshot.timestamp,
    domNodeCount: snapshot.domNodeCount,
    usedJSHeapSize: snapshot.rendererHeap?.usedSize ?? null,
    totalJSHeapSize: snapshot.rendererHeap?.totalSize ?? null,
    runtimeConversationCache: snapshot.runtimeConversationCache ?? null,
    mainProcessMemoryBytes: snapshot.processMemory.main_process_memory_bytes ?? null,
    appWorkerMemory: snapshot.appWorkerMemory ?? null,
    rssKiB: snapshot.processMemory.groups.reduce((total, group) => total + group.rss_kib, 0),
    physicalFootprintKiB: snapshot.processMemory.groups.reduce(
      (total, group) => total + group.physical_footprint_kib,
      0
    ),
    groups: snapshot.processMemory.groups,
    // Keep process ancestry for memory regressions without retaining command arguments.
    processes: snapshot.processMemory.processes.map(
      ({ command: _command, ...processInfo }) => processInfo
    ),
  }
}
