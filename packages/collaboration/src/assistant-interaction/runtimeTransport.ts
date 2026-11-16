import type { RuntimeTaskAddress } from "@wegent/chat-core/runtime";
import type { AssistantInteractionTransport } from "./createAssistantInteraction";
import type { AssistantInteractionRequest } from "./types";

export interface RuntimeAssistantBridge {
  send(input: {
    address: RuntimeTaskAddress;
    message: string;
    clientUserMessageId: string;
    attachmentIds?: number[];
    interruptWhenBusy?: boolean;
    runtimeOptions?: AssistantInteractionRequest["runtimeOptions"];
    conversationContext: "private_discussion";
    queueIfBusy: boolean;
  }): Promise<{
    accepted: boolean;
    taskId: string;
    status?: "queued" | "running";
    queuePosition?: number | null;
    turnId?: string;
    error?: string | null;
  }>;
  cancel(address: RuntimeTaskAddress): Promise<boolean>;
  transcript(
    address: RuntimeTaskAddress,
  ): ReturnType<AssistantInteractionTransport["getRuntimeTranscript"]>;
}

/** The bridge only exposes the existing Runtime operations; it owns no transcript store. */
export function createRuntimeAssistantTransport(
  bridge: RuntimeAssistantBridge,
): AssistantInteractionTransport {
  return {
    async sendRuntimeMessage(input) {
      return bridge.send(input);
    },
    async cancelRuntimeTask(address) {
      return { accepted: await bridge.cancel(address) };
    },
    getRuntimeTranscript(address) {
      return bridge.transcript(address);
    },
  };
}
