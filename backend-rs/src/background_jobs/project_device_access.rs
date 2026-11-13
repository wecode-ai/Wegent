//! Personal device consent is limited to a manual, fixed, owner-initiated run.

use super::authority;
use serde_json::Value;

pub(crate) fn personal_owner(owner: i64, device: &Value) -> i64 {
    if authority::truthy(&device["spec"]["workspaceOwnerId"]) {
        0
    } else {
        owner
    }
}

pub(crate) fn personal_fixed_device(
    policy: &Value,
    actor: i64,
    automatic: bool,
    owner: i64,
    device: i64,
) -> bool {
    !automatic
        && actor > 0
        && actor == owner
        && policy["mode"] == "fixed"
        && authority::integer(&policy["environment_id"]) == Some(device)
}

pub(crate) struct DeviceAccess<'a> {
    pub actor: i64,
    pub automatic: bool,
    pub selection: &'a Value,
    pub explicit_device: bool,
}

impl DeviceAccess<'_> {
    pub(crate) fn permits_owner(&self, owner: i64, device: i64) -> bool {
        if self.automatic || self.actor <= 0 || self.actor != owner {
            return false;
        }
        let Some(route) = self
            .selection
            .get("runner_routing")
            .filter(|v| v.is_object())
        else {
            return self.explicit_device;
        };
        std::iter::once(route)
            .chain(
                self.selection["group_runner_requirements"]
                    .as_object()
                    .into_iter()
                    .flat_map(|routes| routes.values()),
            )
            .all(|route| {
                personal_fixed_device(
                    &route["execution_policy"],
                    self.actor,
                    self.automatic,
                    owner,
                    device,
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn workspace_devices_do_not_inherit_the_registration_accounts_personal_consent() {
        assert_eq!(personal_owner(7, &json!({"spec":{}})), 7);
        assert_eq!(
            personal_owner(7, &json!({"spec":{"workspaceOwnerId":9}})),
            0
        );
    }

    #[test]
    fn cp11_cp12_cp15_personal_consent_requires_manual_owner_and_exact_fixed_device() {
        let fixed = json!({"execution_policy":{"mode":"fixed","environment_id":"42"}});
        for (actor, owner, automatic, policy, expected) in [
            (7, 7, false, fixed.clone(), true),
            (8, 7, false, fixed.clone(), false),
            (7, 7, true, fixed.clone(), false),
            (
                7,
                7,
                false,
                json!({"execution_policy":{"mode":"project_pool"}}),
                false,
            ),
            (
                7,
                7,
                false,
                json!({"execution_policy":{"mode":"fixed","environment_id":"43"}}),
                false,
            ),
        ] {
            let selection = json!({"runner_routing":policy});
            assert_eq!(
                DeviceAccess {
                    actor,
                    automatic,
                    selection: &selection,
                    explicit_device: true
                }
                .permits_owner(owner, 42),
                expected
            );
        }
    }

    #[test]
    fn a_group_pool_cannot_borrow_a_members_personal_consent() {
        let mut selection = json!({
            "runner_routing":{"execution_policy":{"mode":"fixed","environment_id":"42"}},
            "group_runner_requirements":{"member":{"execution_policy":{"mode":"project_pool"}}}
        });
        assert!(
            !DeviceAccess {
                actor: 7,
                automatic: false,
                selection: &selection,
                explicit_device: true
            }
            .permits_owner(7, 42)
        );
        selection["group_runner_requirements"]["member"]["execution_policy"] =
            json!({"mode":"fixed","environment_id":"42"});
        assert!(
            DeviceAccess {
                actor: 7,
                automatic: false,
                selection: &selection,
                explicit_device: false
            }
            .permits_owner(7, 42)
        );
    }

    #[test]
    fn legacy_unbound_requests_do_not_turn_into_personal_device_pools() {
        let selection = json!({});
        assert!(
            !DeviceAccess {
                actor: 7,
                automatic: false,
                selection: &selection,
                explicit_device: false
            }
            .permits_owner(7, 42)
        );
        assert!(
            DeviceAccess {
                actor: 7,
                automatic: false,
                selection: &selection,
                explicit_device: true
            }
            .permits_owner(7, 42)
        );
    }
}
