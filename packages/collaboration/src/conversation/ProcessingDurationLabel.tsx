import { useEffect, useState } from "react";
import { useConversationTranslation } from "./ConversationTranslation";
import { formatDuration } from "./blocks/processingDuration";

interface ProcessingDurationLabelProps {
  startedAt: number | undefined;
  completedAt: number | undefined;
  durationMs?: number;
  isRunning: boolean;
}

export function ProcessingDurationLabel({
  startedAt,
  completedAt,
  durationMs,
  isRunning,
}: ProcessingDurationLabelProps) {
  const { t, translate } = useConversationTranslation();
  const [now, setNow] = useState(() => Date.now());
  const isTicking =
    isRunning && completedAt === undefined && startedAt !== undefined;

  useEffect(() => {
    if (!isTicking) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [isTicking]);

  const end = completedAt ?? (isRunning ? now : undefined);
  const elapsed =
    durationMs !== undefined
      ? Math.max(0, durationMs)
      : startedAt === undefined || end === undefined
        ? 0
        : Math.max(0, end - startedAt);
  const duration = formatDuration(elapsed, translate.locale ?? "zh-CN");
  const label = isRunning
    ? elapsed < 1000
      ? t("assistant_status.working")
      : t("assistant_status.working_for", { duration })
    : t("assistant_status.worked_for", { duration });

  return (
    <span data-testid="processing-duration-label" className="tabular-nums">
      {label}
    </span>
  );
}
