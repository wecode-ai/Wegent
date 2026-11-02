import * as fs from 'node:fs'

function descendantOf(pid, rootPid, parents) {
  const visited = new Set()
  while (pid && !visited.has(pid)) {
    if (pid === rootPid) return true
    visited.add(pid)
    pid = parents.get(pid)
  }
  return false
}

export function diskRootMetadata(paths, io = fs) {
  return paths.map(path => {
    try {
      const disk = io.statfsSync(path)
      return {
        path,
        device: io.statSync(path).dev,
        filesystemType: disk.type,
        totalBytes: disk.blocks * disk.bsize,
        availableBytes: disk.bavail * disk.bsize,
      }
    } catch (error) {
      return { path, unavailable: error.code ?? error.name }
    }
  })
}

export function openDeletedDiskFiles(
  rootPid,
  filesystemDevice,
  { io = fs, now = Date.now, budgetMs = 2000 } = {}
) {
  const result = {
    rootPid,
    allocatedBytes: 0,
    files: [],
    errors: [],
    truncated: false,
    mountNamespaces: {},
    excludedDevices: {},
  }
  if (!Number.isInteger(rootPid) || rootPid <= 0) return result
  const deadline = now() + budgetMs
  const parents = new Map()
  const seen = new Set()
  const failure = error => {
    const code = error.code ?? error.name
    if (!result.errors.includes(code)) result.errors.push(code)
  }
  try {
    for (const pidText of io.readdirSync('/proc')) {
      if (!/^\d+$/.test(pidText)) continue
      if (now() >= deadline) break
      try {
        const status = io.readFileSync(`/proc/${pidText}/status`, 'utf8')
        const parent = status.match(/^PPid:\s+(\d+)/m)
        if (parent) parents.set(Number(pidText), Number(parent[1]))
      } catch (error) {
        failure(error)
      }
    }
    for (const pid of parents.keys()) {
      if (!descendantOf(pid, rootPid, parents)) continue
      if (now() >= deadline) break
      try {
        const namespace = io.readlinkSync(`/proc/${pid}/ns/mnt`)
        result.mountNamespaces[namespace] = (result.mountNamespaces[namespace] ?? 0) + 1
      } catch (error) {
        failure(error)
      }
      try {
        for (const fd of io.readdirSync(`/proc/${pid}/fd`)) {
          if (now() >= deadline) break
          const path = `/proc/${pid}/fd/${fd}`
          try {
            const stat = io.statSync(path)
            const allocatedBytes = stat.blocks * 512
            const identity = `${stat.dev}:${stat.ino}`
            if (
              !stat.isFile() ||
              stat.nlink !== 0 ||
              allocatedBytes < 1024 ** 2 ||
              seen.has(identity)
            )
              continue
            seen.add(identity)
            if (stat.dev !== filesystemDevice) {
              const excluded = (result.excludedDevices[stat.dev] ??= {
                files: 0,
                allocatedBytes: 0,
              })
              excluded.files++
              excluded.allocatedBytes += allocatedBytes
              continue
            }
            result.allocatedBytes += allocatedBytes
            result.files.push({
              pid,
              process: io.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(),
              path: io.readlinkSync(path),
              sizeBytes: stat.size,
              allocatedBytes,
            })
          } catch (error) {
            failure(error)
          }
        }
      } catch (error) {
        failure(error)
      }
    }
  } catch (error) {
    failure(error)
  }
  result.truncated = now() >= deadline
  result.files.sort((left, right) => right.allocatedBytes - left.allocatedBytes)
  result.files = result.files.slice(0, 20)
  return result
}
