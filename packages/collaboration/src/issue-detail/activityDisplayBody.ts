export function activityDisplayBody(body: string, fallback: string): string {
  const marker = body.trim();
  if (!marker || !/^[A-Z0-9_]+$/.test(marker)) return body || fallback;
  const actor = marker.includes("CLAUDE")
    ? "Claude"
    : marker.includes("CODEX")
      ? "Codex"
      : null;
  if (actor === "Claude" && /(COMPLETED|PASSED)/.test(marker))
    return "Claude 已完成，Codex 阶段已自动解锁";
  if (actor === "Codex" && /(COMPLETED|PASSED)/.test(marker))
    return "Codex 已完成，所有自动化阶段已完成";
  if (actor && /(PLAN_SUBMITTED|ASSIGNED|STARTED)/.test(marker))
    return `自动化规则已将当前阶段分配给 ${actor}`;
  return "自动化流程已更新";
}
