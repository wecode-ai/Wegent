import { useEffect, useState } from "react";
import type { RequestUserInputPayload } from "@wegent/chat-core/runtime";
import { hasRequestUserInputResponse } from "@wegent/chat-core/runtime-user-input";

export function requestUserInputExpired(
  payload: RequestUserInputPayload,
  now = Date.now(),
) {
  if (payload.interactionStatus && payload.interactionStatus !== "pending") {
    return payload.interactionStatus === "expired";
  }
  if (hasRequestUserInputResponse(payload)) return false;
  return (
    typeof payload.expiresAtUnixMs === "number" &&
    Number.isFinite(payload.expiresAtUnixMs) &&
    payload.expiresAtUnixMs <= now
  );
}

export function useRequestUserInputDeadline(payload: RequestUserInputPayload) {
  const [now, setNow] = useState(Date.now);
  const deadline = payload.expiresAtUnixMs;
  const settled =
    hasRequestUserInputResponse(payload) ||
    Boolean(
      payload.interactionStatus && payload.interactionStatus !== "pending",
    );
  const expired = requestUserInputExpired(payload, now);

  useEffect(() => {
    if (deadline === undefined || settled || expired) return;
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 1000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [deadline, settled, expired]);

  const seconds = Math.max(0, Math.ceil(((deadline ?? now) - now) / 1000));
  const remainingTime =
    deadline === undefined || settled || expired
      ? null
      : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return { expired, remainingTime };
}
