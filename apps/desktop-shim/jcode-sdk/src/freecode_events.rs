//! core `StreamEvent` → jcode `ApiEvent` (Phase 4, spec "Streaming events").
//!
//! Stateful per session: jcode marks the end of a reasoning block
//! (`ReasoningDone`) and reports a cancelled turn as `TurnStopped`, neither of
//! which core sends as its own event.

use jcode_harness_api::{ApiEvent, ErrorCode, TurnStopReason};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Default)]
pub(crate) struct SessionState {
    reasoning_open: bool,
    pub(crate) cancel_requested: bool,
    pub(crate) turn_open: bool,
}

pub(crate) type States = HashMap<String, SessionState>;

/// Translate one core line. Events come back paired with the session they
/// belong to, so a session-less `ApiEvent` (`Error`) still reaches only that
/// session's subscribers.
pub(crate) fn translate(states: &mut States, line: &Value) -> Vec<(ApiEvent, String)> {
    let (Some(kind), Some(sid)) = (
        line.get("type").and_then(Value::as_str),
        line.get("sessionId").and_then(Value::as_str),
    ) else {
        return Vec::new();
    };
    let session_id = sid.to_string();
    let state = states.entry(session_id.clone()).or_default();
    let text = |key: &str| line.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let mut out = Vec::new();

    // Any non-reasoning output ends a reasoning block.
    if state.reasoning_open && kind != "thinking_delta" && kind != "thinking" {
        state.reasoning_open = false;
        out.push(ApiEvent::ReasoningDone {
            session_id: session_id.clone(),
            duration_secs: None,
        });
    }

    match kind {
        "text_delta" => out.push(ApiEvent::TextDelta {
            session_id: session_id.clone(),
            text: text("delta"),
            message_id: None,
        }),
        "thinking_delta" => {
            state.reasoning_open = true;
            out.push(ApiEvent::ReasoningDelta {
                session_id: session_id.clone(),
                text: text("delta"),
            });
        }
        "tool_start" => {
            let call_id = text("toolCallId");
            let name = text("toolName");
            // Core starts executing as soon as it announces a call.
            out.push(ApiEvent::ToolStart {
                session_id: session_id.clone(),
                call_id: call_id.clone(),
                name: name.clone(),
            });
            out.push(ApiEvent::ToolExec {
                session_id: session_id.clone(),
                call_id,
                name,
            });
        }
        "tool_complete" => {
            let output = text("result");
            let success = line.get("success").and_then(Value::as_bool).unwrap_or(true);
            out.push(ApiEvent::ToolDone {
                session_id: session_id.clone(),
                call_id: text("toolCallId"),
                name: text("toolName"),
                error: (!success).then(|| output.clone()),
                output,
            });
        }
        "usage_totals" => {
            let n = |key: &str| line.get(key).and_then(Value::as_u64);
            out.push(ApiEvent::TokenUsage {
                session_id: session_id.clone(),
                input: n("totalInputTokens").unwrap_or(0),
                output: n("totalOutputTokens").unwrap_or(0),
                cache_read_input: n("totalCacheReadTokens"),
                cache_creation_input: n("totalCacheWriteTokens"),
            });
        }
        "turn_started" => {
            state.turn_open = true;
            out.push(status(&session_id, "running"));
        }
        "done" => {
            state.turn_open = false;
            if std::mem::take(&mut state.cancel_requested) {
                out.push(ApiEvent::TurnStopped {
                    session_id: session_id.clone(),
                    reason: TurnStopReason::Interrupted,
                    message: "Interrupted".into(),
                    provider_stop_reason: None,
                });
            } else {
                out.push(ApiEvent::TurnDone {
                    session_id: session_id.clone(),
                    pending_soft_interrupts: None,
                });
            }
            out.push(status(&session_id, "idle"));
        }
        "session.error" => {
            state.turn_open = false;
            state.cancel_requested = false;
            out.extend(failure(&session_id, text("error")));
        }
        "permission_asked" => out.push(ApiEvent::PermissionRequest {
            session_id: session_id.clone(),
            request_id: text("requestId"),
            tool_name: text("toolName"),
            description: text("description"),
        }),
        "compaction_start" => out.push(status(&session_id, "compacting")),
        "compaction_complete" => {
            let now = if state.turn_open { "running" } else { "idle" };
            out.push(status(&session_id, now));
        }
        _ => {}
    }
    out.into_iter().map(|event| (event, session_id.clone())).collect()
}

/// A dead turn, in jcode's order: `TurnStopped` first, then the legacy `Error`.
pub(crate) fn failure(session_id: &str, message: String) -> Vec<ApiEvent> {
    vec![
        ApiEvent::TurnStopped {
            session_id: session_id.to_string(),
            reason: TurnStopReason::Failure,
            message: message.clone(),
            provider_stop_reason: None,
        },
        ApiEvent::Error {
            code: ErrorCode::Internal,
            message,
        },
        status(session_id, "idle"),
    ]
}

pub(crate) fn status(session_id: &str, status: &str) -> ApiEvent {
    ApiEvent::SessionStatus {
        session_id: session_id.to_string(),
        status: status.to_string(),
        pending_soft_interrupts: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(lines: &[Value]) -> Vec<ApiEvent> {
        let mut states = States::new();
        lines
            .iter()
            .flat_map(|l| translate(&mut states, l))
            .map(|(e, _)| e)
            .collect()
    }

    #[test]
    fn reasoning_closes_before_text_and_turn_ends_idle() {
        let events = run(&[
            json!({"type":"thinking_delta","sessionId":"s","delta":"hm"}),
            json!({"type":"text_delta","sessionId":"s","delta":"hi"}),
            json!({"type":"done","sessionId":"s","content":"hi"}),
        ]);
        assert!(matches!(events[0], ApiEvent::ReasoningDelta { .. }));
        assert!(matches!(events[1], ApiEvent::ReasoningDone { .. }));
        assert!(matches!(&events[2], ApiEvent::TextDelta { text, .. } if text == "hi"));
        assert!(matches!(events[3], ApiEvent::TurnDone { .. }));
        assert!(matches!(&events[4], ApiEvent::SessionStatus { status, .. } if status == "idle"));
    }

    #[test]
    fn failed_tool_carries_error_and_cancel_becomes_interrupted() {
        let mut states = States::new();
        let done = translate(
            &mut states,
            &json!({"type":"tool_complete","sessionId":"s","toolCallId":"c","toolName":"bash","result":"boom","success":false}),
        );
        assert!(matches!(&done[0].0, ApiEvent::ToolDone { error: Some(e), .. } if e == "boom"));
        states.get_mut("s").unwrap().cancel_requested = true;
        let stop = translate(&mut states, &json!({"type":"done","sessionId":"s","content":""}));
        assert!(matches!(
            stop[0].0,
            ApiEvent::TurnStopped { reason: TurnStopReason::Interrupted, .. }
        ));
    }

    #[test]
    fn session_error_is_stopped_then_error_and_lines_without_session_are_dropped() {
        let events = run(&[
            json!({"type":"session.error","sessionId":"s","error":"provider 500"}),
            json!({"type":"mcp.server.started","server":"x"}),
        ]);
        assert!(matches!(events[0], ApiEvent::TurnStopped { reason: TurnStopReason::Failure, .. }));
        assert!(matches!(&events[1], ApiEvent::Error { message, .. } if message == "provider 500"));
        assert_eq!(events.len(), 3);
    }

    #[test]
    fn permission_request_passes_through() {
        let events = run(&[json!({
            "type":"permission_asked","sessionId":"s","requestId":"r1",
            "toolName":"bash","description":"run ls","args":{}
        })]);
        assert!(matches!(&events[0], ApiEvent::PermissionRequest { request_id, tool_name, .. }
            if request_id == "r1" && tool_name == "bash"));
    }
}
