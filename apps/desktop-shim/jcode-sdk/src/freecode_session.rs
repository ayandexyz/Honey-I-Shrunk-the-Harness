//! Session + turn methods over freecode core (Phase 4, spec "Session + turn
//! methods"). `client.rs` keeps upstream's signatures and calls in here.

use crate::client::{Inner, RuntimeInfo};
use crate::errors::{Error, ErrorKind, Result};
use crate::freecode::{call, publish, send_request, session_info};
use crate::freecode_events::{failure, status};
use jcode_harness_api::{ApiEvent, HistoryMessage, ModelRouteInfo, RenderedImage, SessionInfo};
use serde_json::{Value, json};
use std::sync::Arc;

/// A method with no freecode equivalent yet: a clean error the harness
/// already renders ("Failed to …"), never a panic that kills its worker.
pub(crate) fn unsupported(what: &str) -> Error {
    Error::new(
        ErrorKind::Harness(jcode_harness_api::ErrorCode::UnknownRequest),
        format!("{what} is not supported by freecode yet"),
    )
}

pub(crate) fn create_session(inner: &Inner, working_dir: Option<String>) -> Result<SessionInfo> {
    let mut params = json!({});
    if let Some(dir) = &working_dir {
        params["projectPath"] = json!(dir);
    }
    let started = call(inner, "session.start", params)?;
    let id = started
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::new(ErrorKind::UnexpectedReply, "session.start: no sessionId"))?;
    // Core's own title for a fresh session is "Session <id>"; leave it unset
    // so the desktop shows its placeholder until the first turn names it.
    session_info(&json!({ "id": id, "projectPath": working_dir }))
}

/// `session.resume` loads the session into core and returns its transcript,
/// which is kept for the `get_history` call the harness makes right after.
pub(crate) fn attach_session(inner: &Inner, session_id: &str) -> Result<SessionInfo> {
    let resumed = call(inner, "session.resume", json!({ "sessionId": session_id }))?;
    if let Ok(mut history) = inner.history.lock() {
        history.insert(
            session_id.to_string(),
            resumed.get("messages").cloned().unwrap_or(Value::Null),
        );
    }
    session_info(&json!({ "id": session_id }))
}

pub(crate) fn history(
    inner: &Inner,
    session_id: &str,
) -> Result<(Vec<HistoryMessage>, Vec<RenderedImage>)> {
    let cached = inner.history.lock().ok().and_then(|mut h| h.remove(session_id));
    let messages = match cached {
        Some(messages) => messages,
        None => call(inner, "session.resume", json!({ "sessionId": session_id }))?
            .get("messages")
            .cloned()
            .unwrap_or(Value::Null),
    };
    Ok((history_messages(&messages), Vec::new()))
}

/// Core's `SerializedMessage[]` → jcode rows. The desktop renders only user
/// and assistant text, so tool parts are dropped, and harness-written user
/// messages (auto-poke, notifications) are hidden — except a steer, which the
/// user typed.
fn history_messages(messages: &Value) -> Vec<HistoryMessage> {
    let Some(messages) = messages.as_array() else {
        return Vec::new();
    };
    messages
        .iter()
        .filter(|m| {
            matches!(m.get("synthetic").and_then(Value::as_str), None | Some("steer"))
        })
        .filter_map(|m| {
            let role = m.get("role").and_then(Value::as_str)?;
            let content = m
                .get("parts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|p| matches!(p.get("type").and_then(Value::as_str), Some("text" | "code")))
                .filter_map(|p| p.get("content").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            Some(HistoryMessage {
                response_stats: None,
                role: role.to_string(),
                content,
            })
        })
        .collect()
}

/// jcode's send is fire-and-forget: acceptance and the turn arrive as events.
/// Core's `session.send` instead answers when the turn ends, so the request
/// is left in flight and its reply only matters if it fails.
pub(crate) fn send_message(
    inner: &Arc<Inner>,
    session_id: &str,
    content: &str,
    images: Vec<(String, String)>,
) -> Result<()> {
    let mut params = json!({
        "sessionId": session_id,
        "message": content,
        "images": wire_images(images),
    });
    if let Some(mode) = agent_mode(inner, session_id) {
        params["agentMode"] = json!(mode);
    }
    let reply = send_request(inner, "session.send", params)?;
    if let Ok(mut states) = inner.sessions.lock() {
        states.entry(session_id.to_string()).or_default().turn_open = true;
    }
    publish(
        inner,
        ApiEvent::MessageAccepted {
            session_id: session_id.to_string(),
        },
        None,
    );
    publish(inner, status(session_id, "running"), None);

    let inner = Arc::clone(inner);
    let session_id = session_id.to_string();
    std::thread::Builder::new()
        .name("freecode-send".into())
        .spawn(move || {
            let Ok(Err(error)) = reply.recv() else {
                return;
            };
            // `session.error` normally closed the turn already; only a turn
            // nothing has closed gets a failure here.
            let still_open = inner
                .sessions
                .lock()
                .ok()
                .and_then(|mut s| s.get_mut(&session_id).map(|s| std::mem::take(&mut s.turn_open)))
                .unwrap_or(false);
            if still_open {
                for event in failure(&session_id, error.to_string()) {
                    publish(&inner, event, Some(&session_id));
                }
            }
        })
        .map_err(|e| Error::new(ErrorKind::Transport, e.to_string()))?;
    Ok(())
}

/// Hidden continuation: unlike `send_message`, no `MessageAccepted`/
/// `SessionStatus(running)` — the only production callers (jcode's
/// turn-retry and crash-recovery) already know the session is idle and
/// drive their own retry/attention UI off `TurnDone`/`Error`, not accept.
/// Core refuses outright if a turn is somehow already active, surfaced the
/// same way any other failed reply is: `failure()` if nothing closed the
/// turn first.
pub(crate) fn send_system_reminder(
    inner: &Arc<Inner>,
    session_id: &str,
    reminder: &str,
) -> Result<()> {
    let reply = send_request(
        inner,
        "session.sendSystemReminder",
        json!({ "sessionId": session_id, "reminder": reminder }),
    )?;
    if let Ok(mut states) = inner.sessions.lock() {
        states.entry(session_id.to_string()).or_default().turn_open = true;
    }
    let inner = Arc::clone(inner);
    let session_id = session_id.to_string();
    std::thread::Builder::new()
        .name("freecode-reminder".into())
        .spawn(move || {
            let Ok(Err(error)) = reply.recv() else {
                return;
            };
            let still_open = inner
                .sessions
                .lock()
                .ok()
                .and_then(|mut s| s.get_mut(&session_id).map(|s| std::mem::take(&mut s.turn_open)))
                .unwrap_or(false);
            if still_open {
                for event in failure(&session_id, error.to_string()) {
                    publish(&inner, event, Some(&session_id));
                }
            }
        })
        .map_err(|e| Error::new(ErrorKind::Transport, e.to_string()))?;
    Ok(())
}

/// Steering: core delivers it into the running turn and answers at once.
pub(crate) fn steer(
    inner: &Inner,
    session_id: &str,
    content: &str,
    images: Vec<(String, String)>,
) -> Result<()> {
    let mut params = json!({
        "sessionId": session_id,
        "message": content,
        "images": wire_images(images),
        "streamingBehavior": "steer",
    });
    if let Some(mode) = agent_mode(inner, session_id) {
        params["agentMode"] = json!(mode);
    }
    call(inner, "session.send", params).map(|_| ())
}

/// freecode addition: the mode the user last picked, the way the TUI starts
/// a fresh session on `config.getLastAgentMode` rather than a hardcoded
/// default. `None` when core has never recorded one (fresh install).
pub(crate) fn last_agent_mode(inner: &Inner) -> Result<Option<String>> {
    let result = call(inner, "config.getLastAgentMode", json!({}))?;
    Ok(result.as_str().map(str::to_string))
}

/// freecode addition: desktop-chosen agent mode for a session's next turn.
/// Also persists it as core's `lastAgentMode` (`config.setLastAgentMode`,
/// fire-and-forget like the TUI's own call) so the next new session restores
/// it via `last_agent_mode` instead of silently falling back to "build".
pub(crate) fn set_agent_mode(inner: &Inner, session_id: &str, mode: &str) {
    if let Ok(mut modes) = inner.agent_modes.lock() {
        modes.insert(session_id.to_string(), mode.to_string());
    }
    let _ = call(inner, "config.setLastAgentMode", json!({ "mode": mode }));
}

pub(crate) fn agent_mode(inner: &Inner, session_id: &str) -> Option<String> {
    inner.agent_modes.lock().ok()?.get(session_id).cloned()
}

/// jcode passes `(media_type, base64)` pairs.
fn wire_images(images: Vec<(String, String)>) -> Value {
    images
        .into_iter()
        .map(|(media_type, data)| json!({ "data": data, "mediaType": media_type }))
        .collect()
}

pub(crate) fn cancel(inner: &Inner, session_id: &str) -> Result<()> {
    if let Ok(mut states) = inner.sessions.lock() {
        let state = states.entry(session_id.to_string()).or_default();
        if state.turn_open {
            state.cancel_requested = true;
        }
    }
    call(inner, "session.stop", json!({ "sessionId": session_id })).map(|_| ())
}

/// `session.fork`'s reply is a bare id string, not an object — `session_info`
/// needs `{"id": ...}` or `SessionInfo::session_id` (a required field) fails
/// to deserialize.
fn fork(inner: &Inner, session_id: &str) -> Result<String> {
    let forked = call(inner, "session.fork", json!({ "sessionId": session_id }))?;
    forked
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| Error::new(ErrorKind::UnexpectedReply, "session.fork: expected a string id"))
}

pub(crate) fn fork_session(inner: &Inner, session_id: &str) -> Result<SessionInfo> {
    let fork_id = fork(inner, session_id)?;
    session_info(&json!({ "id": fork_id }))
}

/// jcode's "create a fresh session containing a runtime-compacted handoff,
/// parent unchanged" — freecode has no single operation for that, so this is
/// fork (clone the transcript) + resume (register the clone in memory, since
/// compact needs `getSession` to find it) + compact (summarize it in place).
pub(crate) fn transfer_session(inner: &Inner, session_id: &str) -> Result<SessionInfo> {
    let fork_id = fork(inner, session_id)?;
    call(inner, "session.resume", json!({ "sessionId": fork_id }))?;
    call(inner, "session.compact", json!({ "sessionId": fork_id }))?;
    session_info(&json!({ "id": fork_id }))
}

pub(crate) fn compact(inner: &Inner, session_id: &str) -> Result<String> {
    let result = call(inner, "session.compact", json!({ "sessionId": session_id }))?;
    Ok(result.as_str().map(str::to_string).unwrap_or_default())
}

/// `None` clears back to core's generated "Session <id>" placeholder.
/// core's `session.rename` always resolves to a concrete display string (it
/// never leaves a session titleless), so there is no "generated, no explicit
/// title" case to represent — `title` on the synthesized event always
/// mirrors `display_title`. `session.rename` is a plain request/reply, not a
/// stream event, so the shim publishes `SessionRenamed` itself once core
/// confirms the write; that's what lets the sidebar and panel header update
/// live without a full session-list refresh.
pub(crate) fn rename_session(inner: &Inner, session_id: &str, title: Option<String>) -> Result<()> {
    let mut params = json!({ "sessionId": session_id });
    if let Some(title) = &title {
        params["title"] = json!(title);
    }
    let result = call(inner, "session.rename", params)?;
    let display_title = result
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or(session_id)
        .to_string();
    publish(
        inner,
        ApiEvent::SessionRenamed {
            session_id: session_id.to_string(),
            title: Some(display_title.clone()),
            display_title,
        },
        Some(session_id),
    );
    Ok(())
}

/// `provider:model` (the desktop's explicit-route form) or a bare model id on
/// the current provider. Core's model is per process, not per session.
pub(crate) fn set_model(inner: &Inner, model: &str) -> Result<()> {
    let (provider, model) = match model.split_once(':') {
        Some((provider, model)) => (provider.to_string(), model.to_string()),
        None => (current(inner)?.0.unwrap_or_default(), model.to_string()),
    };
    call(
        inner,
        "config.setCurrentModel",
        json!({ "provider": provider, "model": model }),
    )
    .map(|_| ())
}

/// Persist a plain API key in freecode's config store (`config.setApiKey`,
/// same write path as the CLI's `freecode auth set-key`). Overwrites any key
/// already on file for this provider, so this one call covers both
/// connecting a new provider and updating an existing key.
pub(crate) fn set_api_key(inner: &Inner, provider: &str, api_key: &str) -> Result<()> {
    call(
        inner,
        "config.setApiKey",
        json!({ "provider": provider, "apiKey": api_key }),
    )
    .map(|_| ())
}

/// Model ids for a given provider, regardless of which one is current —
/// for the account panel's "switch to this provider" action, which needs a
/// default model for a provider the session may not be using yet. The
/// session-scoped model list (via `runtime_info`'s routes) only ever covers
/// the CURRENT provider.
pub(crate) fn list_provider_models(inner: &Inner, provider: &str) -> Result<Vec<String>> {
    let result = call(inner, "models.list", json!({ "providerId": provider }))?;
    Ok(result
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|model| model.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect())
}

/// `/skills` — every loaded skill (repo + global + plugin), from `skills.list`.
pub(crate) fn skills_summary(inner: &Inner) -> Result<(Value, String)> {
    let result = call(inner, "skills.list", json!({}))?;
    let skills = result.as_array().cloned().unwrap_or_default();
    let message = if skills.is_empty() {
        "No skills found.".to_string()
    } else {
        let mut lines = vec![format!("**Skills** ({})", skills.len())];
        for skill in &skills {
            let name = skill.get("name").and_then(Value::as_str).unwrap_or("?");
            let scope = skill.get("scope").and_then(Value::as_str).unwrap_or("");
            lines.push(match skill.get("description").and_then(Value::as_str) {
                Some(description) => format!("- **{name}** ({scope}) — {description}"),
                None => format!("- **{name}** ({scope})"),
            });
        }
        lines.join("\n")
    };
    Ok((Value::Array(skills), message))
}

/// `/context` — this session's context-window occupancy, from `context.stats`.
pub(crate) fn context_summary(inner: &Inner, session_id: &str) -> Result<(Value, String)> {
    let stats = call(inner, "context.stats", json!({ "sessionId": session_id }))?;
    let used = stats.get("usedTokens").and_then(Value::as_u64).unwrap_or(0);
    let limit = stats.get("contextLimit").and_then(Value::as_u64);
    let messages = stats.get("messageCount").and_then(Value::as_u64).unwrap_or(0);
    let tools = stats.get("toolCount").and_then(Value::as_u64).unwrap_or(0);
    let model = stats.get("model").and_then(Value::as_str).unwrap_or("unknown");
    let message = match limit {
        Some(limit) if limit > 0 => format!(
            "**Context** — `{model}`: {used}/{limit} tokens used ({messages} messages, {tools} tools)."
        ),
        _ => format!(
            "**Context** — `{model}`: {used} tokens used ({messages} messages, {tools} tools)."
        ),
    };
    Ok((stats, message))
}

/// `/agents` — subagents spawned under this session, from `agents.list`.
pub(crate) fn agents_summary(inner: &Inner, session_id: &str) -> Result<(Value, String)> {
    let result = call(inner, "agents.list", json!({ "sessionId": session_id }))?;
    let agents = result.as_array().cloned().unwrap_or_default();
    let message = if agents.is_empty() {
        "No subagents have run in this session.".to_string()
    } else {
        let mut lines = vec![format!("**Subagents** ({})", agents.len())];
        for agent in &agents {
            let task = agent.get("task").and_then(Value::as_str).unwrap_or("?");
            let status = agent.get("status").and_then(Value::as_str).unwrap_or("?");
            let agent_type = agent
                .get("agentType")
                .and_then(Value::as_str)
                .unwrap_or("general");
            lines.push(format!("- `{status}` ({agent_type}) — {task}"));
        }
        lines.join("\n")
    };
    Ok((result, message))
}

/// `/info` — current provider/model/auth for this session, from `config.get`.
pub(crate) fn info_summary(inner: &Inner, session_id: &str) -> Result<(Value, String)> {
    let (provider, model, auth_method) = current(inner)?;
    let message = format!(
        "**Session info**\n- Session: `{session_id}`\n- Provider: `{}`\n- Model: `{}`\n- Auth: `{}`",
        provider.as_deref().unwrap_or("none"),
        model.as_deref().unwrap_or("none"),
        auth_method.as_deref().unwrap_or("none"),
    );
    Ok((
        json!({ "provider": provider, "model": model, "authMethod": auth_method }),
        message,
    ))
}

/// `/memory` — memory-related settings (`settings.list`, filtered to the
/// `memory.*` keys); `/memory on` or `/memory off` flips recall through
/// `settings.set` first. `cwd` is left blank (core falls back to its own
/// process cwd for a global-only read) since this command has no
/// project path of its own to scope to.
pub(crate) fn memory_summary(inner: &Inner, args: &[String]) -> Result<(Value, String)> {
    if let Some(toggle) = args.first() {
        let toggle = toggle.to_ascii_lowercase();
        if toggle != "on" && toggle != "off" {
            return Err(Error::new(
                ErrorKind::Harness(jcode_harness_api::ErrorCode::UnknownRequest),
                "Usage: `/memory`, `/memory on`, or `/memory off`.",
            ));
        }
        call(
            inner,
            "settings.set",
            json!({ "key": "memory.autoRecall", "value": toggle }),
        )?;
    }
    let result = call(inner, "settings.list", json!({ "cwd": "" }))?;
    let settings: Vec<Value> = result
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|setting| {
            setting
                .get("key")
                .and_then(Value::as_str)
                .is_some_and(|key| key.starts_with("memory."))
        })
        .collect();
    let mut lines = vec!["**Memory settings**".to_string()];
    for setting in &settings {
        let label = setting.get("label").and_then(Value::as_str).unwrap_or("?");
        let value = setting.get("value").and_then(Value::as_str).unwrap_or("?");
        lines.push(match setting.get("locked").and_then(Value::as_str) {
            Some(reason) => format!("- {label}: `{value}` (locked: {reason})"),
            None => format!("- {label}: `{value}`"),
        });
    }
    lines.push("\nUse `/memory on` or `/memory off` to toggle recall.".to_string());
    Ok((Value::Array(settings), lines.join("\n")))
}

/// `/night` (tagged `RuntimeCommand::Overnight` on the wire — the enum lives
/// in the external `jcode_harness_api` crate, which this repo does not own,
/// so the variant keeps its upstream name while the slash command does not).
/// Lists runs, or with `report [run-id]` / `stop <run-id>` reads a morning
/// report or requests a stop, via `night.list` / `night.report` / `night.stop`.
pub(crate) fn night_summary(inner: &Inner, args: &[String]) -> Result<(Value, String)> {
    match args.first().map(String::as_str) {
        Some("stop") => {
            let run_id = args.get(1).ok_or_else(|| {
                Error::new(
                    ErrorKind::Harness(jcode_harness_api::ErrorCode::UnknownRequest),
                    "Usage: `/night stop <run-id>`",
                )
            })?;
            let result = call(inner, "night.stop", json!({ "runId": run_id }))?;
            let stopped = result.get("stopped").and_then(Value::as_bool).unwrap_or(false);
            let message = if stopped {
                format!("Stop requested for run `{run_id}`.")
            } else {
                format!("Could not stop run `{run_id}` — it may not be running.")
            };
            Ok((result, message))
        }
        Some("report") => {
            let run_id = args.get(1).cloned();
            let result = call(inner, "night.report", json!({ "runId": run_id }))?;
            let markdown = result
                .get("markdown")
                .and_then(Value::as_str)
                .unwrap_or("No report available.")
                .to_string();
            Ok((result, markdown))
        }
        _ => {
            let result = call(inner, "night.list", json!({}))?;
            let runs = result.as_array().cloned().unwrap_or_default();
            let message = if runs.is_empty() {
                "No overnight runs recorded yet. Start one with `freecode night \"<objective>\"`.".to_string()
            } else {
                let mut lines = vec![format!("**Overnight runs** ({})", runs.len())];
                for run in &runs {
                    let run_id = run.get("runId").and_then(Value::as_str).unwrap_or("?");
                    let status = run.get("status").and_then(Value::as_str).unwrap_or("?");
                    let objective = run.get("objective").and_then(Value::as_str).unwrap_or("?");
                    let commits = run.get("commits").and_then(Value::as_u64).unwrap_or(0);
                    lines.push(format!("- `{run_id}` [{status}] {objective} ({commits} commits)"));
                }
                lines.push("\nUse `/night report [run-id]` or `/night stop <run-id>`.".to_string());
                lines.join("\n")
            };
            Ok((Value::Array(runs), message))
        }
    }
}

/// `/auth` — connected-provider status. No JSON-RPC equivalent exists yet
/// (see MIGRATION_JCODE_CLI.md), so this shells out to the same one-off
/// `freecode auth status --json` the account sidebar panel uses.
pub(crate) fn auth_status() -> Result<(Value, String)> {
    let stdout = crate::freecode::run_cli(&["auth", "status", "--json"])?;
    let value: Value = serde_json::from_str(&stdout).map_err(|e| {
        Error::new(ErrorKind::UnexpectedReply, format!("auth status --json: {e}"))
    })?;
    let providers = value
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut lines = vec!["**Auth status**".to_string()];
    for provider in &providers {
        let status = provider.get("status").and_then(Value::as_str).unwrap_or("?");
        if status == "not_configured" {
            continue;
        }
        let name = provider
            .get("display_name")
            .and_then(Value::as_str)
            .unwrap_or("?");
        lines.push(format!("- **{name}**: {status}"));
    }
    if lines.len() == 1 {
        lines.push("- No providers configured yet.".to_string());
    }
    Ok((value, lines.join("\n")))
}

/// `/logout <provider>` — `freecode auth logout <provider>`, same reasoning
/// as `auth_status`: no JSON-RPC equivalent exists yet.
pub(crate) fn auth_logout(provider: &str) -> Result<(Value, String)> {
    let stdout = crate::freecode::run_cli(&["auth", "logout", provider])?;
    let trimmed = stdout.trim();
    let message = if trimmed.is_empty() {
        format!("Logged out of `{provider}`.")
    } else {
        format!("Logged out of `{provider}`.\n\n{trimmed}")
    };
    Ok((json!({ "provider": provider, "output": trimmed }), message))
}

/// (provider, model, auth method) from `config.get`.
fn current(inner: &Inner) -> Result<(Option<String>, Option<String>, Option<String>)> {
    let config = call(inner, "config.get", json!({}))?;
    let get = |key: &str| {
        config
            .pointer(&format!("/current/{key}"))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let provider = get("provider");
    let auth = provider.as_ref().map(|p| {
        let oauth = config
            .pointer(&format!("/providers/{p}/authMode"))
            .and_then(Value::as_str)
            == Some("oauth");
        if oauth { "oauth" } else { "api_key" }.to_string()
    });
    Ok((provider, get("model"), auth))
}

/// `ModelInfo` for `session_id`: sent unsolicited after attach and again on
/// model change, so a client can show which model it is talking to.
pub(crate) fn model_info_event(inner: &Inner, session_id: &str) -> Result<ApiEvent> {
    let (provider, model, auth_method) = current(inner)?;
    let reasoning_effort = inner
        .reasoning_efforts
        .lock()
        .ok()
        .and_then(|efforts| efforts.get(session_id).cloned());
    Ok(ApiEvent::ModelInfo {
        session_id: session_id.to_string(),
        provider,
        model,
        reasoning_effort,
        auth_method,
    })
}

/// Sticky per-session override via `session.setReasoningEffort`. Remembered
/// here (not read back from core) because `config.get` only reports the
/// process-global model, not a per-session effort.
pub(crate) fn set_reasoning_effort(inner: &Inner, session_id: &str, effort: &str) -> Result<()> {
    call(
        inner,
        "session.setReasoningEffort",
        json!({ "sessionId": session_id, "effort": effort }),
    )?;
    if let Ok(mut efforts) = inner.reasoning_efforts.lock() {
        efforts.insert(session_id.to_string(), effort.to_string());
    }
    Ok(())
}

pub(crate) fn runtime_info(inner: &Inner, session_id: &str) -> Result<RuntimeInfo> {
    let (provider, model, auth_method) = current(inner)?;
    let routes = match &provider {
        Some(provider) => call(inner, "models.list", json!({ "providerId": provider }))
            .map(|models| model_routes(provider, &models))
            .unwrap_or_default(),
        None => Vec::new(),
    };
    Ok(RuntimeInfo {
        server: "freecode-core".into(),
        protocol_version: 0,
        capabilities: Vec::new(),
        healthy: true,
        session_id: session_id.to_string(),
        providers: provider.iter().cloned().collect(),
        provider,
        model,
        reasoning_effort: None,
        auth_method,
        routes,
    })
}

fn model_routes(provider: &str, models: &Value) -> Vec<ModelRouteInfo> {
    models
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = m.get("id").and_then(Value::as_str)?;
            Some(ModelRouteInfo {
                model: id.to_string(),
                provider: provider.to_string(),
                api_method: "api".into(),
                available: true,
                detail: m.get("name").and_then(Value::as_str).unwrap_or(id).to_string(),
                usage: None,
            })
        })
        .collect()
}

/// Bookmark/unbookmark a session. A non-empty `label` also becomes its
/// title — `session.setSaved`'s reply carries the new title only when that
/// happened, and the shim synthesizes `SessionRenamed` from it itself, the
/// same reason `rename_session` does: a client's event subscription is
/// scoped to the session it attached to, so core's own broadcast (if any)
/// would be dropped for a session renamed from the sidebar without being
/// open.
pub(crate) fn set_session_saved(
    inner: &Inner,
    session_id: &str,
    saved: bool,
    label: Option<String>,
) -> Result<()> {
    let mut params = json!({ "sessionId": session_id, "saved": saved });
    if let Some(label) = &label {
        params["label"] = json!(label);
    }
    let result = call(inner, "session.setSaved", params)?;
    if let Some(display_title) = result.get("title").and_then(Value::as_str) {
        publish(
            inner,
            ApiEvent::SessionRenamed {
                session_id: session_id.to_string(),
                title: Some(display_title.to_string()),
                display_title: display_title.to_string(),
            },
            Some(session_id),
        );
    }
    Ok(())
}

/// jcode's `message_index` is a numeric position; core's `session.rewind`
/// takes an `entryId`. `session.tree` returns the active path in order, so
/// `message_index` is treated as a plain index into it — the same
/// conversion jcode's own backend would do internally, just done here
/// instead. Remembers the pre-rewind leaf so `rewind_undo` has somewhere to
/// go back to.
pub(crate) fn rewind(inner: &Inner, session_id: &str, message_index: usize) -> Result<()> {
    let tree = call(inner, "session.tree", json!({ "sessionId": session_id }))?;
    let entries = tree.as_array().ok_or_else(|| {
        Error::new(ErrorKind::UnexpectedReply, "session.tree: expected an array")
    })?;
    let target = entries
        .get(message_index)
        .and_then(|e| e.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            Error::new(
                ErrorKind::Harness(jcode_harness_api::ErrorCode::InvalidRequest),
                format!("rewind: no entry at index {message_index}"),
            )
        })?
        .to_string();
    let current = entries
        .iter()
        .find(|e| e.get("active").and_then(Value::as_bool) == Some(true))
        .and_then(|e| e.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    call(inner, "session.rewind", json!({ "sessionId": session_id, "entryId": target }))?;
    if let (Ok(mut undo), Some(current)) = (inner.rewind_undo.lock(), current) {
        undo.insert(session_id.to_string(), current);
    }
    Ok(())
}

/// Restore the leaf `rewind` moved away from. No-op-with-error if nothing
/// was rewound on this client since the last undo (matches core's own
/// "nothing to do" shape for an unreachable request, not a panic).
pub(crate) fn rewind_undo(inner: &Inner, session_id: &str) -> Result<()> {
    let target = inner
        .rewind_undo
        .lock()
        .ok()
        .and_then(|mut undo| undo.remove(session_id))
        .ok_or_else(|| unsupported("rewind_undo: nothing to undo"))?;
    call(inner, "session.rewind", json!({ "sessionId": session_id, "entryId": target })).map(|_| ())
}

/// jcode's three decisions onto core's `PermissionAnswer`. "Always" is
/// core's project-wide rule, its closest match; deny is an answer too.
pub(crate) fn respond_to_permission(
    inner: &Inner,
    request_id: &str,
    decision: jcode_harness_api::PermissionDecision,
) -> Result<()> {
    use jcode_harness_api::PermissionDecision::*;
    let decision = match decision {
        Allow => "allow-once",
        AllowAlways => "allow-always",
        Deny => "deny",
    };
    call(
        inner,
        "permission.answer",
        json!({ "requestId": request_id, "decision": decision }),
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_keeps_user_and_assistant_text_and_hides_harness_messages() {
        let rows = history_messages(&json!([
            {"role":"user","parts":[{"type":"text","content":"fix it"}]},
            {"role":"assistant","parts":[{"type":"tool","tool":{"name":"read","args":{}}},{"type":"text","content":"done"}]},
            {"role":"user","synthetic":"auto_poke","parts":[{"type":"text","content":"continue"}]},
            {"role":"user","synthetic":"steer","parts":[{"type":"text","content":"also tests"}]},
        ]));
        let got: Vec<_> = rows.iter().map(|r| (r.role.as_str(), r.content.as_str())).collect();
        assert_eq!(
            got,
            vec![("user", "fix it"), ("assistant", "done"), ("user", "also tests")]
        );
    }

    #[test]
    fn routes_come_from_models_list() {
        let routes = model_routes("openai", &json!([{"id":"gpt-x","name":"GPT X"},{"name":"no id"}]));
        assert_eq!(routes.len(), 1);
        assert_eq!((routes[0].model.as_str(), routes[0].detail.as_str()), ("gpt-x", "GPT X"));
    }
}
