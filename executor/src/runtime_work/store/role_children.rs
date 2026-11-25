use super::*;

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct RoleChildKey {
    user: i64,
    device: String,
    root: String,
    parent: String,
}

impl RoleChildKey {
    fn new(user: i64, device: &str, root: &str, parent: &str) -> Self {
        Self {
            user,
            device: device.to_owned(),
            root: root.to_owned(),
            parent: parent.to_owned(),
        }
    }

    pub(super) fn from_task(task: &RuntimeTaskLink) -> Option<Self> {
        let origin = &task.runtime_handle["origin"];
        Some(Self::new(
            origin["userId"].as_i64()?,
            origin["deviceId"].as_str()?,
            origin["roleDelegation"]["root"].as_str()?,
            origin["sourceTaskId"].as_str()?,
        ))
    }
}

impl RuntimeWorkIndex {
    pub(super) fn update_role_child_task(
        &mut self,
        id: &str,
        previous: Option<RoleChildKey>,
        current: Option<RoleChildKey>,
    ) {
        if previous == current {
            return;
        }
        if let Some(previous) = previous {
            if let Entry::Occupied(mut entry) = self.role_children.entry(previous) {
                entry.get_mut().remove(id);
                if entry.get().is_empty() {
                    entry.remove();
                }
            }
        }
        if let Some(current) = current {
            self.role_children
                .entry(current)
                .or_default()
                .insert(id.to_owned());
        }
    }
}

impl RuntimeWorkStore {
    /// Project only the unarchived children of the requested role parent.
    pub(in crate::runtime_work) fn role_child_task_values<T>(
        &self,
        user: i64,
        device: &str,
        root: &str,
        parent: &str,
        project: impl Fn(&RuntimeTaskLink) -> Option<T>,
    ) -> Vec<T> {
        self.refresh_index_from_disk_if_changed();
        let Ok(index) = self.index.lock() else {
            return Vec::new();
        };
        index
            .role_children
            .get(&RoleChildKey::new(user, device, root, parent))
            .into_iter()
            .flatten()
            .filter_map(|id| index.tasks.get(id))
            .filter(|task| task.status != "archived")
            .filter_map(project)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn child(id: &str, user: i64, device: &str, root: &str, parent: &str) -> RuntimeTaskLink {
        RuntimeTaskLink {
            local_task_id: id.into(),
            runtime_handle: serde_json::json!({"origin":{
                "userId":user,"deviceId":device,"roleDelegation":{"root":root},"sourceTaskId":parent},
                "executionRequest":{"user_id":user}}),
            ..Default::default()
        }
    }

    #[test]
    fn role_child_lookup_tracks_updates_rekeys_and_persisted_changes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("index.json");
        let store = RuntimeWorkStore::new(path.clone());
        let ids = |store: &RuntimeWorkStore, user, device, root, parent| {
            store.role_child_task_values(user, device, root, parent, |task| {
                Some(task.local_task_id.clone())
            })
        };
        store.upsert_task(child("child", 7, "desktop", "root", "parent"));
        store.upsert_task(child("other-owner", 8, "desktop", "root", "parent"));
        store.upsert_task(child("other-device", 7, "remote", "root", "parent"));
        store.upsert_task(child("other-root", 7, "desktop", "unrelated", "parent"));
        store.upsert_task(child("other-parent", 7, "desktop", "root", "unrelated"));
        let mut archived = child("archived", 7, "desktop", "root", "parent");
        archived.status = "archived".into();
        store.upsert_task(archived);
        assert_eq!(ids(&store, 7, "desktop", "root", "parent"), ["child"]);
        store.update_task("child", |task| task.status = "archived".into());
        assert!(ids(&store, 7, "desktop", "root", "parent").is_empty());
        store.update_task_without_snapshot("child", |task| task.status = "active".into());
        assert_eq!(ids(&store, 7, "desktop", "root", "parent"), ["child"]);

        store.update_task("child", |task| {
            task.runtime_handle["origin"]["sourceTaskId"] = serde_json::json!("moved");
        });
        assert!(ids(&store, 7, "desktop", "root", "parent").is_empty());
        assert_eq!(ids(&store, 7, "desktop", "root", "moved"), ["child"]);
        store
            .try_update_task("child", |task| {
                task.runtime_handle["origin"]["roleDelegation"]["root"] =
                    serde_json::json!("new-root");
            })
            .unwrap()
            .unwrap();
        assert!(ids(&store, 7, "desktop", "root", "moved").is_empty());

        let reopened = RuntimeWorkStore::new(path);
        assert_eq!(ids(&reopened, 7, "desktop", "new-root", "moved"), ["child"]);
        reopened.rekey_task("child", "renamed", |_| {}).unwrap();
        assert_eq!(ids(&store, 7, "desktop", "new-root", "moved"), ["renamed"]);
        reopened.upsert_task(child("renamed", 9, "desktop", "root", "parent"));
        assert!(ids(&store, 7, "desktop", "new-root", "moved").is_empty());
        assert_eq!(ids(&store, 9, "desktop", "root", "parent"), ["renamed"]);
        reopened.delete_task("renamed").unwrap();
        assert!(ids(&store, 9, "desktop", "root", "parent").is_empty());
    }
}
