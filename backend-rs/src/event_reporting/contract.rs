// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::config::ReporterConfig;
use super::generated_contract;

macro_rules! string_enum {
    ($(#[$meta:meta])* pub enum $name:ident { $($variant:ident => $value:literal),+ $(,)? }) => {
        $(#[$meta])*
        pub enum $name { $($variant),+ }

        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $value),+ }
            }
        }
    };
}

string_enum! {
    #[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
    #[repr(usize)]
    pub enum EventKind {
        KnowledgeBaseCreated => "knowledge.kb.created",
        KnowledgeBaseDeleted => "knowledge.kb.deleted",
        KnowledgeDocumentCreated => "knowledge.document.created",
        KnowledgeDocumentDeleted => "knowledge.document.deleted",
        KnowledgeDocumentContentUpdated => "knowledge.document.content.updated",
        KnowledgeDocumentIndexCleanupFinished => "knowledge.document.index_cleanup.finished",
        KnowledgeIndexDispatchFinished => "knowledge.index.dispatch.finished",
        KnowledgeIndexDispatchSkipped => "knowledge.index.dispatch.skipped",
        KnowledgeIndexAttemptStarted => "knowledge.index.attempt.started",
        KnowledgeIndexAttemptFinished => "knowledge.index.attempt.finished",
        KnowledgeIndexGenerationTerminal => "knowledge.index.generation.terminal",
        KnowledgeIndexExecutionFinished => "knowledge.index.execution.finished",
        KnowledgeConversionDispatchFinished => "knowledge.conversion.dispatch.finished",
        KnowledgeConversionAttemptStarted => "knowledge.conversion.attempt.started",
        KnowledgeConversionAttemptFinished => "knowledge.conversion.attempt.finished",
        KnowledgeConversionCallbackFinished => "knowledge.conversion.callback.finished",
        KnowledgeRetrievalRequestFinished => "knowledge.retrieval.request.finished",
        KnowledgeRetrievalExecutionFinished => "knowledge.retrieval.execution.finished",
        KnowledgeUsageKbRecorded => "knowledge.usage.kb.recorded",
        KnowledgeUsageDocumentRecorded => "knowledge.usage.document.recorded",
        KnowledgeExternalSyncStarted => "knowledge.external.sync.started",
        KnowledgeExternalSyncFinished => "knowledge.external.sync.finished",
        KnowledgeExternalDocumentChecked => "knowledge.external.document.checked",
        KnowledgeExternalImportDispatched => "knowledge.external.import.dispatched",
        KnowledgeExternalImportAttemptFinished => "knowledge.external.import.attempt.finished",
        KnowledgeExternalBodyLanded => "knowledge.external.body.landed",
        KnowledgeCodeWikiGenerationStarted => "knowledge.code_wiki.generation.started",
        KnowledgeCodeWikiGenerationFinished => "knowledge.code_wiki.generation.finished",
        KnowledgeCodeWikiPublishFinished => "knowledge.code_wiki.publish.finished",
        KnowledgeSummaryAttemptFinished => "knowledge.summary.attempt.finished",
        KnowledgeRetrievalTargetFinished => "knowledge.retrieval.target.finished",
        KnowledgeRetrievalResultObserved => "knowledge.retrieval.result.observed",
        KnowledgeRetrievalContextRecorded => "knowledge.retrieval.context.recorded",
        KnowledgeEmbeddingCallFinished => "knowledge.embedding.call.finished",
        KnowledgeStorageOperationFinished => "knowledge.storage.operation.finished",
        KnowledgeGenerationTaskFinished => "knowledge.generation.task.finished",
        KnowledgeDocumentReadFinished => "knowledge.document.read.finished",
        KnowledgeWikiConnectionTestFinished => "knowledge.wiki.connection_test.finished",
        KnowledgeWikiBindingRequestFinished => "knowledge.wiki.binding.request.finished",
        KnowledgeWikiBindingChanged => "knowledge.wiki.binding.changed"
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AdvGroup {
    Attribution,
    ReadWiki,
    ModelStorage,
    QualityDetail,
}

impl AdvGroup {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Attribution => "attribution",
            Self::ReadWiki => "read_wiki",
            Self::ModelStorage => "model_storage",
            Self::QualityDetail => "quality_detail",
        }
    }
}

impl EventKind {
    #[must_use]
    pub(crate) const fn as_index(self) -> usize {
        self as usize
    }

    #[must_use]
    pub(crate) fn adv_group(self) -> Option<AdvGroup> {
        let group = match self {
            Self::KnowledgeRetrievalTargetFinished => Some(AdvGroup::Attribution),
            Self::KnowledgeRetrievalResultObserved | Self::KnowledgeRetrievalContextRecorded => {
                Some(AdvGroup::QualityDetail)
            }
            Self::KnowledgeEmbeddingCallFinished
            | Self::KnowledgeStorageOperationFinished
            | Self::KnowledgeGenerationTaskFinished => Some(AdvGroup::ModelStorage),
            Self::KnowledgeDocumentReadFinished
            | Self::KnowledgeWikiConnectionTestFinished
            | Self::KnowledgeWikiBindingRequestFinished
            | Self::KnowledgeWikiBindingChanged => Some(AdvGroup::ReadWiki),
            _ => None,
        };
        debug_assert!(match group {
            Some(group) =>
                generated_contract::ADV_GROUPS.contains(&(self.as_str(), group.as_str())),
            None => true,
        });
        group
    }

    #[must_use]
    pub(crate) fn allowed(self, config: &ReporterConfig) -> bool {
        match self.adv_group() {
            None => true,
            Some(AdvGroup::Attribution) => config.adv_attribution_enabled,
            Some(AdvGroup::ReadWiki) => config.adv_read_wiki_enabled,
            Some(AdvGroup::ModelStorage) => config.adv_model_storage_enabled,
            Some(AdvGroup::QualityDetail) => config.adv_quality_detail_enabled,
        }
    }
}

string_enum! {
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub enum EventStatus {
        Started => "started",
        Success => "success",
        Failure => "failure",
        Skipped => "skipped",
        Cancelled => "cancelled",
        Partial => "partial",
        Completed => "completed",
        Failed => "failed"
    }
}

string_enum! {
    #[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
    pub enum Field {
        KbType => "kb_type", SourceType => "source_type", DeleteMode => "delete_mode",
        Trigger => "trigger", FileExtension => "file_extension", ContentBytes => "content_bytes",
        HadActiveIndex => "had_active_index", ReindexRequested => "reindex_requested",
        Generation => "generation", Attempt => "attempt", TaskId => "task_id",
        RequestId => "request_id", OperationId => "operation_id",
        ParentOperationId => "parent_operation_id", UserId => "user_id", Reason => "reason",
        ReasonCode => "reason_code", Route => "route", RetryScheduled => "retry_scheduled",
        PreservationReason => "preservation_reason", ExecutionMode => "execution_mode",
        ChunkCount => "chunk_count", KnowledgeBaseIds => "knowledge_base_ids",
        RequestedKbIds => "requested_kb_ids", Entrypoint => "entrypoint",
        ClientSurface => "client_surface", RouteMode => "route_mode",
        ResultCount => "result_count", TotalEstimatedTokens => "total_estimated_tokens",
        RestrictedMode => "restricted_mode", Provider => "provider", Decision => "decision",
        CallbackType => "callback_type", Accepted => "accepted", Converter => "converter",
        MediaType => "media_type", GenerationType => "generation_type", Published => "published",
        TargetKind => "target_kind", ModelId => "model_id", ModelProvider => "model_provider",
        StartedAt => "started_at", FinishedAt => "finished_at", IndexScheduled => "index_scheduled",
        DeletedChunks => "deleted_chunks", IndexedCount => "indexed_count",
        DocumentRef => "document_ref", Stage => "stage", SourceVersion => "source_version",
        Action => "action", IndexTaskId => "index_task_id", CallbackStatus => "callback_status",
        TaskState => "task_state", ResultStatus => "result_status", PreviousStatus => "previous_status",
        StorageType => "storage_type", RetrieverName => "retriever_name",
        RetrieverNamespace => "retriever_namespace", EmbeddingModelName => "embedding_model_name",
        EmbeddingModelNamespace => "embedding_model_namespace", ModelRole => "model_role",
        ModelName => "model_name", ModelNamespace => "model_namespace", Protocol => "protocol",
        Operation => "operation", RetrievalMode => "retrieval_mode", TopK => "top_k",
        ScoreThreshold => "score_threshold", SubtaskId => "subtask_id", Offset => "offset",
        ReturnedLength => "returned_length", TotalLength => "total_length", HasMore => "has_more",
        ConnectionId => "connection_id", ConnectorType => "connector_type", Ok => "ok",
        Version => "version", ExecutionId => "execution_id", Rank => "rank", Score => "score",
        ReturnedCount => "returned_count", ContextId => "context_id", InjectionMode => "injection_mode",
        InvocationId => "invocation_id", ActorUserId => "actor_user_id",
        ActorEmployeeId => "actor_employee_id", ActorType => "actor_type",
        EffectiveReaderId => "effective_reader_id", ActorOrgId => "actor_org_id",
        ActorOrgVersion => "actor_org_version", UsageStage => "usage_stage",
        MetricDefinitionVersion => "metric_definition_version", BatchId => "batch_id",
        BatchPart => "batch_part", ExpectedDocumentCount => "expected_document_count",
        ContentRevision => "content_revision", ContentChangedAt => "content_changed_at",
        SnapshotId => "snapshot_id", SourceWatermark => "source_watermark",
        CoverageState => "coverage_state"
    }
}

impl Field {
    #[must_use]
    pub(crate) const fn accepts_list(self) -> bool {
        matches!(self, Self::KnowledgeBaseIds | Self::RequestedKbIds)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_event_catalog_has_expected_size() {
        assert_eq!(generated_contract::EVENT_TYPES.len(), 40);
        assert_eq!(generated_contract::STATUSES.len(), 8);
        assert_eq!(generated_contract::FIELDS.len(), 100);
        assert_eq!(
            EventKind::ALL
                .iter()
                .map(|value| value.as_str())
                .collect::<Vec<_>>(),
            generated_contract::EVENT_TYPES
        );
        assert_eq!(
            Field::ALL
                .iter()
                .map(|value| value.as_str())
                .collect::<Vec<_>>(),
            generated_contract::FIELDS
        );
        assert_eq!(
            EventStatus::ALL
                .iter()
                .map(|value| value.as_str())
                .collect::<Vec<_>>(),
            generated_contract::STATUSES
        );
    }

    #[test]
    fn checked_in_manifest_matches_generated_catalog() {
        let manifest: serde_json::Value = serde_json::from_str(include_str!(
            "../../../shared/event_reporting/schema/knowledge_events_v1.json"
        ))
        .unwrap();
        let strings = |name: &str| {
            manifest[name]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap())
                .collect::<Vec<_>>()
        };
        assert_eq!(strings("event_types"), generated_contract::EVENT_TYPES);
        assert_eq!(strings("fields"), generated_contract::FIELDS);
        assert_eq!(strings("statuses"), generated_contract::STATUSES);
        let manifest_groups = manifest["adv_groups"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(event, group)| (event.as_str(), group.as_str().unwrap()))
            .collect::<std::collections::HashMap<_, _>>();
        let generated_groups = generated_contract::ADV_GROUPS
            .iter()
            .copied()
            .collect::<std::collections::HashMap<_, _>>();
        let implemented_groups = EventKind::ALL
            .iter()
            .filter_map(|event| {
                event
                    .adv_group()
                    .map(|group| (event.as_str(), group.as_str()))
            })
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(manifest_groups, generated_groups);
        assert_eq!(implemented_groups, generated_groups);
    }

    #[test]
    fn read_event_is_in_read_wiki_group() {
        assert_eq!(
            EventKind::KnowledgeDocumentReadFinished.adv_group(),
            Some(AdvGroup::ReadWiki)
        );
    }
}
