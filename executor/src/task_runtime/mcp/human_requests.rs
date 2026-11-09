//! Use native questions and the existing Issue thread, not a second conversation.
use super::{json, tool, Value};

pub(super) fn list_tool() -> Value {
    tool("list_human_requests", "Read durable Issue questions, exact request IDs, versions and recipients. After asking request_user_input_async, the responsible participant must assign the question using assign_human_request. Continue independent work; wait before steps depending on an answer.", json!({
        "type":"object", "properties":{
            "space_id":{"type":"string"}, "item_id":{"type":"string"}
        }
    }))
}

pub(super) fn assign_tool() -> Value {
    tool("assign_human_request", "Assign or transfer a pending Issue question to a specific authorized person. The Issue owner or group leader must choose the person; never broadcast or invent a coordinator. Read list_human_requests first. Set blocks_progress if steps depend on the answer; independent steps continue. Business answers never grant execution approval.",json!({
        "type":"object", "properties":{
            "space_id":{"type":"string"}, "item_id":{"type":"string"},
            "request_id":{"type":"string"}, "version":{"type":"integer","minimum":1},
            "recipient_user_id":{"type":"integer","minimum":0},
            "recipient_name":{"type":"string","minLength":1},
            "blocks_progress":{"type":"boolean"}
        }, "required":["request_id","version","recipient_user_id","recipient_name"]
    }))
}

pub(super) fn blocking_tool() -> Value {
    tool("set_human_request_blocking", "Explicitly mark whether steps in your original Issue execution depend on this question. Read list_human_requests for its ID, version and runtime_device_id. This never assigns a person or resets waiting time. Keep independent work moving; wait before dependent actions. Only the reporting execution may change this flag.", json!({
        "type":"object", "properties":{
            "space_id":{"type":"string"}, "item_id":{"type":"string"},
            "request_id":{"type":"string"}, "version":{"type":"integer","minimum":1},
            "runtime_device_id":{"type":"string","minLength":1},
            "blocks_progress":{"type":"boolean"}
        }, "required":["request_id","version","runtime_device_id","blocks_progress"]
    }))
}
