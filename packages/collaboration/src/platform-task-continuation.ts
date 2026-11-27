import { createContext, useContext } from "react";

export const PlatformTaskConnection = createContext<{
  apiBaseUrl: string;
  userId: number;
} | null>(null);

export function usePlatformTaskContinuation(taskId?: string | number | null) {
  const connection = useContext(PlatformTaskConnection);
  if (
    !connection ||
    typeof window === "undefined" ||
    !/^[1-9]\d*$/.test(String(taskId)) ||
    !Number.isSafeInteger(Number(taskId))
  )
    return null;
  try {
    const api = new URL(connection.apiBaseUrl, window.location.origin);
    if (
      !["https:", "http:"].includes(api.protocol) ||
      api.username ||
      api.password ||
      api.search ||
      api.hash
    )
      return null;
    return `wework://platform-tasks/${encodeURIComponent(api.href.replace(/\/+$/, ""))}/${connection.userId}/${taskId}`;
  } catch {
    return null;
  }
}
