import { createHook } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

// Write each sample immediately: test workers are terminated without an exit flush.
// Resource names, file paths, arguments and file contents are deliberately omitted.
export function startAsyncResourceDiagnostics(
  outputFile,
  intervalMs = 1000,
  slowMs = 100,
) {
  mkdirSync(dirname(outputFile), { recursive: true });
  const pending = new Map();
  const delay = monitorEventLoopDelay({ resolution: 20 });
  const started = performance.now();
  let previousCpu = process.cpuUsage();
  let previousLoop = performance.eventLoopUtilization();
  let writeFailed = false;
  const write = (record) => {
    if (writeFailed) return;
    try {
      appendFileSync(
        outputFile,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          pid: process.pid,
          elapsedMs: performance.now() - started,
          ...record,
        })}\n`,
      );
    } catch (error) {
      writeFailed = true;
      console.error(
        "[node-async-diagnostics] Cannot write evidence:",
        error.code,
      );
    }
  };
  const hook = createHook({
    init(id, type) {
      if (type.startsWith("FSREQ"))
        pending.set(id, { type, start: performance.now() });
    },
    destroy(id) {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      const durationMs = performance.now() - request.start;
      if (durationMs >= slowMs)
        write({ event: "filesystem", type: request.type, durationMs });
    },
  });
  const sample = (phase) => {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const loop = performance.eventLoopUtilization();
    write({
      event: "sample",
      phase,
      pendingFilesystem: pending.size,
      oldestFilesystemMs: Math.max(
        0,
        ...[...pending.values()].map((item) => now - item.start),
      ),
      eventLoopMaxMs: Number.isFinite(delay.max) ? delay.max / 1e6 : 0,
      eventLoopUtilization: performance.eventLoopUtilization(loop, previousLoop)
        .utilization,
      cpuUserMs: (cpu.user - previousCpu.user) / 1000,
      cpuSystemMs: (cpu.system - previousCpu.system) / 1000,
      rssBytes: process.memoryUsage().rss,
    });
    previousCpu = cpu;
    previousLoop = loop;
    delay.reset();
  };
  hook.enable();
  delay.enable();
  sample("start");
  const timer = setInterval(() => sample("interval"), intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    hook.disable();
    sample("end");
    delay.disable();
  };
}

if (process.env.WEWORK_NODE_DIAGNOSTIC_DIR) {
  startAsyncResourceDiagnostics(
    join(process.env.WEWORK_NODE_DIAGNOSTIC_DIR, `node-${process.pid}.jsonl`),
  );
}
