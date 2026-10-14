"""Match Runtime observations to immutable user input and native turn identities."""

from dataclasses import dataclass
from typing import Any


def _identity(value: object) -> str:
    return value if isinstance(value, str) else ""


@dataclass(frozen=True)
class RuntimeTurn:
    trigger_id: str
    turn_id: str

    @classmethod
    def from_event(cls, payload: dict[str, Any]) -> "RuntimeTurn":
        return cls(
            _identity(
                payload.get("clientUserMessageId")
                or payload.get("client_user_message_id")
            ),
            _identity(payload.get("subtaskId") or payload.get("subtask_id")),
        )

    def matches(
        self,
        *,
        trigger_id: object,
        turn_id: object,
        followup: bool,
    ) -> bool:
        """A queued continuation requires proof of its own input or bound turn."""
        trigger = _identity(trigger_id)
        turn = _identity(turn_id)
        if self.trigger_id:
            return self.trigger_id == trigger and (
                not turn or not self.turn_id or self.turn_id == turn
            )
        if turn:
            return bool(self.turn_id) and self.turn_id == turn
        return not followup


def bind_turn(metadata: dict[str, Any], identity: RuntimeTurn) -> dict[str, Any]:
    if not identity.turn_id:
        return metadata
    return {**metadata, "runtime_turn_id": identity.turn_id}
