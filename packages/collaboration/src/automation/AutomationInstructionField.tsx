import type { ComponentProps } from "react";
import { Textarea } from "../controls/Textarea";

/** Keep instruction editing consistent across scheduled, project and personal rules. */
export function AutomationInstructionField({
  className,
  rows = 3,
  ...props
}: ComponentProps<"textarea">) {
  return (
    <Textarea
      rows={rows}
      className={
        className ??
        "min-h-24 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
      }
      {...props}
    />
  );
}
