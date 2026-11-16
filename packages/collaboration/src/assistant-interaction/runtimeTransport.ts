import type { RuntimeTaskAddress } from "@wegent/chat-core/runtime";
import type { AssistantInteractionTransport } from "./createAssistantInteraction";
import type { AssistantInteractionRequest } from "./types";

export interface RuntimeAssistantBridge {
  send(input: {
    address: RuntimeTaskAddress;
    message: string;
    clientUserMessageId: string;
    attachmentIds?: number[];
    runtimeOptions?: AssistantInteractionRequest["runtimeOptions"];
    conversationContext: "private_discussion";
    queueIfBusy: true;
  }): Promise<boolean>;
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
      const accepted = await bridge.send(input);
      return { accepted, taskId: input.address.taskId };
    },
    async cancelRuntimeTask(address) {
      return { accepted: await bridge.cancel(address) };
    },
    getRuntimeTranscript(address) {
      return bridge.transcript(address);
    },
  };
}
