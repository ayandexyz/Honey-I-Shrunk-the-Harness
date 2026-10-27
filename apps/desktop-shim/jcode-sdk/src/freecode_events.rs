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
    /// `BackgroundProgress.label` for a running background shell/subagent,
    /// keyed by `shellId`/`agentId` — `shell_output`/`agent_output` carry no
    /// label of their own, so the start event's is remembered here.
    background_labels: HashMap<String, String>,
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
            // jcode's ApiEvent::ToolStart has no args field at all — the UI
            // only ever learns a call's input by accumulating ToolInputDelta
            // chunks (jcode streams them token by token). Core instead sends
            // the whole `args` object in one shot on tool_start, so without
            // this every tool call rendered as "{}" (an empty accumulator),
            // regardless of its real arguments. One complete "delta" is a
            // degenerate but valid stream: the UI's incremental JSON parser
            // handles a single full chunk the same as the last of many.
            if let Some(args) = line.get("args")
                && !call_id.is_empty()
            {
                out.push(ApiEvent::ToolInputDelta {
                    session_id: session_id.clone(),
                    call_id: call_id.clone(),
                    delta: args.to_string(),
                });
            }
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
        "cache_status" => {
            if text("state") == "miss" {
                let n = |key: &str| line.get(key).and_then(Value::as_u64);
                let read = n("cacheReadTokens").unwrap_or(0);
                let write = n("cacheWriteTokens").unwrap_or(0);
                let (reason, harness_caused) = line
                    .pointer("/stats/misses")
                    .and_then(Value::as_array)
                    .and_then(|misses| misses.last())
                    .map(|miss| {
                        (
                            miss.get("reason")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown")
                                .to_string(),
                            miss.get("harnessBug").and_then(Value::as_bool).unwrap_or(false),
                        )
                    })
                    .unwrap_or(("unknown".into(), false));
                out.push(ApiEvent::KvCacheMiss {
                    session_id: session_id.clone(),
                    reason,
                    harness_caused,
                    missed_tokens: write,
                    expected_tokens: read + write,
                    read_tokens: read,
                    documented_cause: None,
                    message: text("message"),
                });
            }
        }
        "shell_start" => {
            let label = format!("$ {}", text("command"));
            state.background_labels.insert(text("shellId"), label.clone());
            out.push(background_progress(&session_id, text("shellId"), label, "Running".into(), false));
        }
        "shell_output" => {
            let task_id = text("shellId");
            let label = state.background_labels.get(&task_id).cloned().unwrap_or_default();
            out.push(background_progress(&session_id, task_id, label, last_line(&text("chunk")), false));
        }
        "shell_exit" => {
            let task_id = text("shellId");
            let label = state.background_labels.remove(&task_id).unwrap_or_default();
            out.push(background_progress(&session_id, task_id, label, exit_summary(&text("status")), true));
        }
        "agent_start" => {
            let label = format!("{}: {}", text("agentType"), text("task"));
            state.background_labels.insert(text("agentId"), label.clone());
            out.push(background_progress(&session_id, text("agentId"), label, "Running".into(), false));
        }
        "agent_output" => {
            let task_id = text("agentId");
            let label = state.background_labels.get(&task_id).cloned().unwrap_or_default();
            out.push(background_progress(&session_id, task_id, label, last_line(&text("chunk")), false));
        }
        "agent_exit" => {
            let task_id = text("agentId");
            let label = state.background_labels.remove(&task_id).unwrap_or_default();
            out.push(background_progress(&session_id, task_id, label, exit_summary(&text("status")), true));
        }
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

fn background_progress(
    session_id: &str,
    task_id: String,
    label: String,
    summary: String,
    done: bool,
) -> ApiEvent {
    ApiEvent::BackgroundProgress {
        session_id: session_id.to_string(),
        task_id,
        label,
        percent: None,
        summary,
        done,
    }
}

/// jcode's `summary` is a one-line status; core's shell/agent output chunks
/// can carry several lines and trailing whitespace. Last non-empty line,
/// trimmed, stands in for a live tail — same compromise the TUI's shells
/// panel makes with `shell_output`.
fn last_line(chunk: &str) -> String {
    chunk
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Running")
        .to_string()
}

fn exit_summary(status: &str) -> String {
    match status {
        "completed" => "Done".into(),
        "failed" => "Failed".into(),
        "killed" => "Killed".into(),
        other => other.into(),
    }
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
    fn tool_start_carries_args_as_one_input_delta() {
        let events = run(&[json!({
            "type":"tool_start","sessionId":"s","toolCallId":"c1","toolName":"bash",
            "args":{"command":"ls -la"}
        })]);
        assert!(matches!(&events[0], ApiEvent::ToolStart { call_id, name, .. }
            if call_id == "c1" && name == "bash"));
        assert!(matches!(&events[1], ApiEvent::ToolInputDelta { call_id, delta, .. }
            if call_id == "c1" && delta == r#"{"command":"ls -la"}"#));
        assert!(matches!(&events[2], ApiEvent::ToolExec { call_id, .. } if call_id == "c1"));
    }

    #[test]
    fn cache_miss_carries_reason_from_stats_and_warm_status_is_dropped() {
        let events = run(&[
            json!({
                "type":"cache_status","sessionId":"s","state":"miss",
                "cacheReadTokens":4000,"cacheWriteTokens":46000,
                "message":"KV cache miss: ~46K tokens resent",
                "stats":{"sessionPct":10,"misses":[
                    {"missedTokens":46000,"reason":"harness: prefix rewritten","harnessBug":true}
                ]}
            }),
            json!({"type":"cache_status","sessionId":"s","state":"warm","cacheReadTokens":100,"cacheWriteTokens":0}),
        ]);
        assert!(matches!(
            &events[0],
            ApiEvent::KvCacheMiss { reason, harness_caused: true, missed_tokens: 46000, read_tokens: 4000, expected_tokens: 50000, .. }
                if reason == "harness: prefix rewritten"
        ));
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn background_shell_progress_keeps_label_across_output_and_exit() {
        let events = run(&[
            json!({"type":"shell_start","sessionId":"s","shellId":"sh1","command":"pnpm test","cwd":"/repo"}),
            json!({"type":"shell_output","sessionId":"s","shellId":"sh1","chunk":"ok 1 passed\n"}),
            json!({"type":"shell_exit","sessionId":"s","shellId":"sh1","status":"completed","exitCode":0}),
        ]);
        assert!(matches!(
            &events[0],
            ApiEvent::BackgroundProgress { task_id, label, done: false, .. }
                if task_id == "sh1" && label == "$ pnpm test"
        ));
        assert!(matches!(
            &events[1],
            ApiEvent::BackgroundProgress { label, summary, done: false, .. }
                if label == "$ pnpm test" && summary == "ok 1 passed"
        ));
        assert!(matches!(
            &events[2],
            ApiEvent::BackgroundProgress { label, summary, done: true, .. }
                if label == "$ pnpm test" && summary == "Done"
        ));
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
