export function activityClassNames(
  ...values: Array<string | false | null | undefined>
): string {
  return twMerge(values.filter(Boolean).join(" "));
}
import { twMerge } from "tailwind-merge";
