// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

pub(super) async fn read_install_marketplace_name(path: PathBuf) -> Result<String, AppIpcError> {
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    let slots = SLOTS.get_or_init(|| Arc::new(Semaphore::new(1))).clone();
    read_with_slots(slots, move || {
        crate::local::plugin_catalog::read_marketplace_manifest_name(&path)
    })
    .await
}

async fn read_with_slots(
    slots: Arc<Semaphore>,
    read: impl FnOnce() -> Result<String, String> + Send + 'static,
) -> Result<String, AppIpcError> {
    let work = async {
        let permit = slots
            .acquire_owned()
            .await
            .map_err(marketplace_management_error)?;
        tokio::task::spawn_blocking(move || {
            // A timed-out caller cannot release the slot of a still-running filesystem read.
            let _permit = permit;
            read()
        })
        .await
        .map_err(marketplace_management_error)?
        .map_err(marketplace_management_error)
    };
    tokio::time::timeout(MARKETPLACE_MANIFEST_TIMEOUT, work)
        .await
        .map_err(|_| {
            AppIpcError::new(
                "marketplace_manifest_timeout",
                "Reading the marketplace manifest timed out. Retry the installation.",
            )
        })?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn started_read_keeps_its_slot_after_timeout_and_recovers_when_released() {
        let slots = Arc::new(Semaphore::new(1));
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let first_slots = slots.clone();
        let first = tokio::spawn(read_with_slots(first_slots, move || {
            started.send(()).unwrap();
            release_rx.recv().unwrap();
            Ok("first".into())
        }));
        started_rx.await.unwrap();
        tokio::time::pause();
        tokio::time::advance(MARKETPLACE_MANIFEST_TIMEOUT + Duration::from_millis(1)).await;
        assert_eq!(
            first.await.unwrap().unwrap_err().code,
            "marketplace_manifest_timeout"
        );
        assert_eq!(slots.available_permits(), 0);

        let retry = read_with_slots(slots.clone(), || panic!("A blocked read was duplicated"));
        let mut retry = std::pin::pin!(retry);
        assert!(futures_util::poll!(&mut retry).is_pending());
        tokio::time::advance(MARKETPLACE_MANIFEST_TIMEOUT + Duration::from_millis(1)).await;
        assert_eq!(
            retry.await.unwrap_err().code,
            "marketplace_manifest_timeout"
        );
        assert_eq!(slots.available_permits(), 0);

        release.send(()).unwrap();
        tokio::time::resume();
        assert_eq!(
            read_with_slots(slots, || Ok("healthy".into()))
                .await
                .unwrap(),
            "healthy"
        );
    }
}
