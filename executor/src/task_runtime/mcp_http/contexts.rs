use super::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ContextLifetime {
    Execution,
    Conversation,
}

#[cfg(test)]
pub(super) fn register_context(
    contexts: &mut HashMap<String, RegisteredContext>,
    context: SpaceMcpRequestContext,
    now: Instant,
) -> String {
    register_context_with_lifetime(contexts, context, now, ContextLifetime::Execution)
}

pub(super) fn register_context_with_lifetime(
    contexts: &mut HashMap<String, RegisteredContext>,
    context: SpaceMcpRequestContext,
    now: Instant,
    lifetime: ContextLifetime,
) -> String {
    let reused = contexts.iter_mut().find(|(_, registered)| {
        registered.lifetime == lifetime
            && (registered.context.shares_unbound_authority(&context)
                || (lifetime == ContextLifetime::Conversation
                    && registered.context.shares_control_conversation(&context)))
    });
    if let Some((handle, registered)) = reused {
        // Keep only the transport identity; execution data always belongs to the current turn.
        registered.context = context;
        registered.expires_at = now + CONTEXT_HANDLE_TTL;
        let handle = handle.clone();
        contexts.retain(|_, registered| registered.expires_at > now);
        return handle;
    }
    contexts.retain(|_, registered| registered.expires_at > now);
    let handle = Uuid::new_v4().to_string();
    contexts.insert(
        handle.clone(),
        RegisteredContext {
            context,
            expires_at: now + CONTEXT_HANDLE_TTL,
            lifetime,
        },
    );
    handle
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{protocol::ExecutionRequest, workbench_control::ControlContext};

    fn request() -> ExecutionRequest {
        ExecutionRequest {
            backend_url: Some("https://backend.example".into()),
            auth_token: Some("principal-a".into()),
            runtime_auth_token: Some("runtime-a".into()),
            extra: serde_json::Map::from_iter([
                ("runtimeDeviceId".into(), json!("device-a")),
                ("runtimeLocalTaskId".into(), json!("task-a")),
            ]),
            ..Default::default()
        }
    }

    #[test]
    fn conversation_handles_preserve_authority_and_execution_isolation() {
        let mut contexts = HashMap::new();
        let now = Instant::now();
        let register = |contexts: &mut HashMap<_, _>, request: &ExecutionRequest| {
            register_context_with_lifetime(
                contexts,
                SpaceMcpRequestContext::control(ControlContext::from_request(request).unwrap()),
                now,
                ContextLifetime::Conversation,
            )
        };
        let original = request();
        let first = register(&mut contexts, &original);
        let mut next_turn = original.clone();
        next_turn.subtask_id = "next-turn".into();
        next_turn.model_config = json!({"model_id":"another-model"});
        assert_eq!(register(&mut contexts, &next_turn), first);
        for changed in [
            ExecutionRequest {
                auth_token: Some("principal-b".into()),
                ..original.clone()
            },
            ExecutionRequest {
                runtime_auth_token: Some("runtime-b".into()),
                ..original.clone()
            },
            ExecutionRequest {
                backend_url: Some("https://other.example".into()),
                ..original.clone()
            },
        ] {
            assert_ne!(register(&mut contexts, &changed), first);
        }
        for key in ["runtimeDeviceId", "runtimeLocalTaskId", "origin"] {
            let mut changed = original.clone();
            changed.extra.insert(key.into(), json!("different"));
            assert_ne!(register(&mut contexts, &changed), first);
        }
        let context =
            SpaceMcpRequestContext::control(ControlContext::from_request(&original).unwrap());
        assert_ne!(register_context(&mut contexts, context.clone(), now), first);
        assert_ne!(
            register_context(&mut contexts, context.clone(), now),
            register_context(&mut contexts, context, now),
        );
    }
}
