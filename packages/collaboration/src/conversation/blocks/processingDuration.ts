import type { ProcessingBlock } from "./types";

export function getDurationText(
  blocks: ProcessingBlock[],
  turnStartedAt: number,
  now: number,
  completedAt: number | null,
  isRunning: boolean,
): string {
  const durationMs = getProcessingDurationMs(
    blocks,
    turnStartedAt,
    now,
    completedAt,
    isRunning,
  );
  if (durationMs < 1000) return "";
  return `已处理 ${formatDuration(durationMs)}`;
}

function getProcessingDurationMs(
  blocks: ProcessingBlock[],
  turnStartedAt: number,
  now: number,
  completedAt: number | null,
  isRunning: boolean,
): number {
  const lastBlock = blocks[blocks.length - 1];
  const last = lastBlock?.completedAt ?? lastBlock?.createdAt ?? turnStartedAt;
  const endTime = isRunning ? now : (completedAt ?? last);
  return Math.max(isRunning ? 1000 : 0, endTime - turnStartedAt);
}

export function formatDuration(durationMs: number, locale = "zh-CN"): string {
  const seconds = Math.floor(Math.max(durationMs, 0) / 1000);
  const units: [number, string][] = [
    [Math.floor(seconds / 86400), "day"],
    [Math.floor((seconds % 86400) / 3600), "hour"],
    [Math.floor((seconds % 3600) / 60), "minute"],
    [seconds % 60, "second"],
  ];
  return units
    .filter(
      ([value, unit]) => value > 0 || (seconds === 0 && unit === "second"),
    )
    .map(([value, unit]) =>
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit,
        unitDisplay: "narrow",
      }).format(value),
    )
    .join(" ");
}
