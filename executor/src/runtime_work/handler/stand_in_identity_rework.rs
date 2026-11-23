//! Native identity conversations use their own authorized transcript and review cursor.
use super::*;
use wegent_local_task_store::store::{DeliveryRole, IdentityReplyItem};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

pub(super) fn identity_source_due(link: &RuntimeTaskLink, reviewed: i64, through: i64) -> bool {
    // An otherwise quiet conversation still needs its final 24 hours reviewed.
    link.updated_at == 0
        || (reviewed < through && reviewed <= link.updated_at.saturating_add(DAY_MS))
}

impl RuntimeWorkRpcHandler {
    pub(super) fn direct_learning_role<'a>(
        &self,
        link: &'a RuntimeTaskLink,
        settings: &Value,
        user: i64,
    ) -> Option<&'a str> {
        if !super::stand_in_history::history_owned(link, user)
            || self.archived_link_is_deleted(link)
        {
            return None;
        }
        super::stand_in_training::identity_learning_role(self, link, settings)
    }

    pub(super) fn visible_identity_tasks(
        &self,
        user: i64,
        settings: &Value,
        role: &str,
    ) -> HashSet<String> {
        self.local_task_links(true)
            .into_iter()
            .filter(|link| self.direct_learning_role(link, settings, user) == Some(role))
            .map(|link| link.local_task_id)
            .collect()
    }

    // A terminal result alone cannot enter the denominator. A later native transcript read
    // must attest to the same item in the same owner-authored turn.
    pub(super) fn record_identity_completion(
        &self,
        task: &str,
        request: &ExecutionRequest,
        turn: Option<&ActiveCodexTurn>,
        item: Option<&str>,
        sent_at: Option<i64>,
    ) {
        let Some(origin) = request.extra.get("origin") else {
            return;
        };
        if origin["type"] != "stand_in_identity"
            || request.extra.contains_key("runtime_generated_user_message")
            || request
                .extra
                .get("source")
                .is_some_and(|source| source["source"] == "im")
        {
            return;
        }
        let (Some(context), Some(user), Some(turn), Some(item), Some(at)) = (
            request.extra.get("standInDeliveryContext"),
            origin["userId"].as_i64(),
            turn,
            item.filter(|id| !id.is_empty()),
            sent_at.filter(|at| *at > 0),
        ) else {
            return;
        };
        let Some(device) = context["roleDeviceId"].as_str() else {
            return;
        };
        if self.verify_local_stand_in_owner(user).is_err() {
            return;
        }
        let role = origin["standInId"].as_str().unwrap_or("@primary");
        let Some(link) = self.local_task_link(task) else {
            return;
        };
        if link.runtime_handle["origin"]["conversationScope"] != origin["conversationScope"] {
            return;
        }
        let versions = crate::task_runtime::mcp::stand_in_turn_versions(request, &turn.turn_id);
        let result = LocalTaskStore::open(self.task_store_path.as_ref()).and_then(|store| {
            let settings = store.configured_personal_stand_in(user, &self.device_id)?;
            if self.direct_learning_role(&link, &settings, user) != Some(role) {
                return Ok(());
            }
            store.record_identity_training_reply(
                DeliveryRole {
                    user,
                    device: &self.device_id,
                    role_device: device,
                    role,
                },
                IdentityReplyItem {
                    task,
                    turn: &turn.turn_id,
                    item,
                },
                at,
                versions.as_ref().map(|(g, m)| (g.as_str(), m.as_str())),
            )
        });
        if result.is_err() {
            log_executor_event("Stand-in native reply receipt unavailable", &[]);
        }
    }
}
