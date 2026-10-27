//! freecode transport (Phase 3 of docs/specs/2026-10-26-jcode-sdk-shim-contract.md).
//!
//! Replaces Jcode's socket + framed protocol with freecode's: `apps/core`
//! spawned as a child, newline-delimited JSON-RPC 2.0 on its stdin/stdout.
//! Stdout carries two kinds of line: replies (`{"jsonrpc","id","result"|"error"}`)
//! and stream events (`{"type", "sessionId", ...}`, core's `StreamEvent`).
//!
//! One core process serves the whole desktop process. The harness opens a
//! fresh `JcodeClient` for every session-list refresh (every few seconds);
//! booting core each time would cost a Node start-up per refresh. Clients are
//! handles on the shared `Inner`, multiplexed by JSON-RPC id, and a dead core
//! is respawned by the next `connect`.

use crate::client::{Inner, Subscriber, event_session};
use crate::errors::{Error, ErrorKind, Result};
use jcode_harness_api::{ApiEvent, SessionInfo};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Reply to one request: the JSON-RPC `result`, or the error it carried.
pub(crate) type Reply = std::result::Result<Value, Error>;

static SHARED: Mutex<Option<Arc<Inner>>> = Mutex::new(None);

/// The live shared core, spawning it if there is none or the last one died.
pub(crate) fn shared_core(request_timeout: Option<Duration>) -> Result<Arc<Inner>> {
    let mut shared = SHARED.lock().map_err(|_| poisoned())?;
    if let Some(inner) = shared.as_ref()
        && !inner.closed.load(Ordering::Acquire)
    {
        return Ok(Arc::clone(inner));
    }
    let inner = spawn_core(request_timeout)?;
    *shared = Some(Arc::clone(&inner));
    Ok(inner)
}

/// How core is started: an explicit override; then the `freecode` binary
/// shipped next to this executable (a packaged Honey — one release is one
/// exact core, upgraded together); then the monorepo's built `apps/core` when
/// this binary lives inside the repo (dev, so core and desktop change
/// together, as the TUI does); then an installed `freecode` on PATH.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CoreCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
}

pub(crate) fn locate_core() -> Result<CoreCommand> {
    if let Some(path) = std::env::var_os("FREECODE_CORE").filter(|v| !v.is_empty()) {
        return Ok(command_for(PathBuf::from(path), None));
    }
    let exe = std::env::current_exe().ok();
    if let Some(bundled) = exe.as_deref().and_then(bundled_core) {
        return Ok(command_for(bundled, None));
    }
    if let Some(root) = exe.as_deref().and_then(monorepo_root) {
        let dist = root.join("apps/core/dist/server.js");
        if dist.is_file() {
            return Ok(command_for(dist, Some(root)));
        }
    }
    if let Some(bin) = find_on_path("freecode") {
        return Ok(command_for(bin, None));
    }
    Err(Error::new(
        ErrorKind::JcodeNotFound,
        "freecode core not found: install freecode, set FREECODE_CORE, or \
         build apps/core (pnpm --filter @thisisayande/freecode-core build)",
    ))
}

/// A `.js` path runs under node; anything else is a freecode binary (`serve`).
fn command_for(path: PathBuf, cwd: Option<PathBuf>) -> CoreCommand {
    if path.extension().is_some_and(|ext| ext == "js") {
        CoreCommand {
            program: PathBuf::from("node"),
            args: vec![path.to_string_lossy().into_owned()],
            cwd,
        }
    } else {
        CoreCommand {
            program: path,
            args: vec!["serve".into()],
            cwd,
        }
    }
}

/// `freecode` (`freecode.exe` on Windows) in the same directory as `exe`.
fn bundled_core(exe: &Path) -> Option<PathBuf> {
    let name = if cfg!(windows) { "freecode.exe" } else { "freecode" };
    Some(exe.parent()?.join(name)).filter(|path| path.is_file())
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

fn monorepo_root(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|dir| dir.join("pnpm-workspace.yaml").is_file())
        .map(Path::to_path_buf)
}

fn spawn_core(request_timeout: Option<Duration>) -> Result<Arc<Inner>> {
    let core = locate_core()?;
    // Spawn from the reader thread, which lives exactly as long as core:
    // Linux delivers PR_SET_PDEATHSIG when the spawning *thread* exits, and
    // the harness connects from short-lived worker threads, so spawning there
    // SIGTERMed core as soon as that worker finished.
    let (tx, rx) = std::sync::mpsc::channel::<Result<Arc<Inner>>>();
    std::thread::Builder::new()
        .name("freecode-core".into())
        .spawn(move || {
            let (mut child, stdout, inner) = match start(&core, request_timeout) {
                Ok(started) => started,
                Err(error) => {
                    let _ = tx.send(Err(error));
                    return;
                }
            };
            eprintln!("jcode-sdk shim: started freecode core pid={}", child.id());
            let _ = tx.send(Ok(Arc::clone(&inner)));
            read_loop(&inner, BufReader::new(stdout));
            let status = child.wait();
            eprintln!("jcode-sdk shim: freecode core exited: {status:?}");
        })
        .map_err(|e| Error::new(ErrorKind::LaunchFailed, e.to_string()))?;
    rx.recv()
        .map_err(|_| Error::new(ErrorKind::LaunchFailed, "freecode core thread died"))?
}

fn start(
    core: &CoreCommand,
    request_timeout: Option<Duration>,
) -> Result<(Child, std::process::ChildStdout, Arc<Inner>)> {
    let mut command = Command::new(&core.program);
    command
        .args(&core.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if let Some(cwd) = &core.cwd {
        command.current_dir(cwd);
    }
    // Core does not exit when its stdin closes, so tie it to our lifetime.
    #[cfg(target_os = "linux")]
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }
    let mut child = command.spawn().map_err(|e| {
        Error::new(
            ErrorKind::LaunchFailed,
            format!("could not start freecode core ({}): {e}", core.program.display()),
        )
    })?;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let inner = Arc::new(Inner {
        writer: Mutex::new(Box::new(stdin)),
        pending: Mutex::new(HashMap::new()),
        subscribers: Mutex::new(Vec::new()),
        next_id: AtomicU64::new(1),
        next_sub: AtomicU64::new(1),
        closed: AtomicBool::new(false),
        request_timeout,
        socket_path: PathBuf::new(),
        client_name: String::new(),
        native_socket: false,
        ssh_process: None,
        // The shared core outlives any one client; it ends with the process.
        shutdown: None,
        client_handles: AtomicUsize::new(0),
        sessions: Mutex::new(crate::freecode_events::States::new()),
        history: Mutex::new(HashMap::new()),
        agent_modes: Mutex::new(HashMap::new()),
    });
    Ok((child, stdout, inner))
}

fn read_loop(inner: &Inner, reader: impl BufRead) {
    for line in reader.lines() {
        let Ok(line) = line else { break };
        // Core's stdout is JSON lines; anything else is stray logging.
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        dispatch(inner, value);
    }
    close(inner, "freecode core exited");
}

fn dispatch(inner: &Inner, value: Value) {
    if value.get("jsonrpc").is_some()
        && let Some(id) = value.get("id").and_then(Value::as_u64)
    {
        let reply = match value.get("error") {
            Some(error) => Err(Error::new(
                ErrorKind::Harness(jcode_harness_api::ErrorCode::Internal),
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("freecode core error")
                    .to_string(),
            )),
            None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
        };
        if let Some(tx) = inner.pending.lock().ok().and_then(|mut p| p.remove(&id)) {
            let _ = tx.send(reply);
        }
        return;
    }
    // TEMP DEBUG (permission-card investigation): confirm core's raw line
    // reaches the shim before translation can hide a parsing gap.
    if value.get("type").and_then(Value::as_str) == Some("permission_asked") {
        eprintln!("[debug permission] raw line from core: {value}");
    }
    let events = match inner.sessions.lock() {
        Ok(mut states) => crate::freecode_events::translate(&mut states, &value),
        Err(_) => return,
    };
    for (event, session) in events {
        if matches!(event, ApiEvent::PermissionRequest { .. }) {
            eprintln!("[debug permission] translated event for session={session}: {event:?}");
        }
        publish(inner, event, Some(&session));
    }
}

/// Deliver to every subscriber not scoped to another session. `target` names
/// the session for events that carry none themselves (`Error`).
pub(crate) fn publish(inner: &Inner, event: ApiEvent, target: Option<&str>) {
    let session = event_session(&event).or(target);
    let Ok(mut subs) = inner.subscribers.lock() else {
        return;
    };
    if matches!(event, ApiEvent::PermissionRequest { .. }) {
        eprintln!(
            "[debug permission] publish: session={session:?} subscriber_filters={:?}",
            subs.iter().map(|(id, f, _)| (*id, f.clone())).collect::<Vec<_>>()
        );
    }
    subs.retain(|(_, filter, tx): &Subscriber| {
        let wanted = match (filter, session) {
            (Some(filter), Some(session)) => filter == session,
            _ => true,
        };
        !wanted || tx.send(event.clone()).is_ok()
    });
}

fn close(inner: &Inner, why: &str) {
    inner.closed.store(true, Ordering::Release);
    if let Ok(mut pending) = inner.pending.lock() {
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err(Error::new(ErrorKind::Disconnected, why)));
        }
    }
    // Dropping every sink ends each EventStream (`next` returns None).
    if let Ok(mut subs) = inner.subscribers.lock() {
        subs.clear();
    }
}

/// Write one JSON-RPC request; its reply arrives on the returned receiver.
pub(crate) fn send_request(
    inner: &Inner,
    method: &str,
    params: Value,
) -> Result<std::sync::mpsc::Receiver<Reply>> {
    if inner.closed.load(Ordering::Acquire) {
        return Err(Error::new(ErrorKind::Disconnected, "freecode core exited"));
    }
    let id = inner.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = std::sync::mpsc::channel::<Reply>();
    inner.pending.lock().map_err(|_| poisoned())?.insert(id, tx);
    let line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    let written = inner.writer.lock().map_err(|_| poisoned()).and_then(|mut w| {
        writeln!(w, "{line}")
            .and_then(|()| w.flush())
            .map_err(|e| Error::new(ErrorKind::Transport, e.to_string()))
    });
    if let Err(error) = written {
        inner.pending.lock().ok().map(|mut p| p.remove(&id));
        return Err(error);
    }
    Ok(rx)
}

/// One JSON-RPC call, blocking until its reply or the request timeout.
pub(crate) fn call(inner: &Inner, method: &str, params: Value) -> Result<Value> {
    let rx = send_request(inner, method, params)?;
    let reply = match inner.request_timeout {
        Some(timeout) => rx.recv_timeout(timeout).map_err(|_| {
            Error::new(ErrorKind::Timeout, format!("{method}: no reply from freecode core"))
        }),
        None => rx
            .recv()
            .map_err(|_| Error::new(ErrorKind::Disconnected, "freecode core exited")),
    };
    reply?
}

/// core `session.list` (every project, newest first) → jcode `SessionInfo`s.
pub(crate) fn list_sessions(inner: &Inner, limit: Option<u32>) -> Result<Vec<SessionInfo>> {
    let result = call(inner, "session.list", json!({}))?;
    let mut sessions: Vec<&Value> = result.as_array().map(|a| a.iter().collect()).unwrap_or_default();
    sessions.sort_by_key(|s| std::cmp::Reverse(s.get("updatedAt").and_then(Value::as_i64)));
    if let Some(limit) = limit {
        sessions.truncate(limit as usize);
    }
    sessions.into_iter().map(session_info).collect()
}

pub(crate) fn session_info(session: &Value) -> Result<SessionInfo> {
    let status = session.get("status").and_then(Value::as_str).unwrap_or("active");
    // jcode's status is runtime activity; freecode's is lifecycle. A listed
    // freecode session is never mid-turn from this client's view.
    let info = json!({
        "session_id": session.get("id"),
        "title": session.get("title"),
        "working_dir": session.get("projectPath"),
        "status": "idle",
        "archived": status == "archived",
        "updated_at_ms": session.get("updatedAt"),
        "last_active_at_ms": session.get("lastTurnAt"),
    });
    serde_json::from_value(info).map_err(|e| {
        Error::new(ErrorKind::UnexpectedReply, format!("session.list: {e}"))
    })
}

fn poisoned() -> Error {
    Error::new(ErrorKind::Transport, "freecode transport lock poisoned")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_path_runs_under_node_and_binary_runs_serve() {
        let js = command_for(PathBuf::from("/r/apps/core/dist/server.js"), None);
        assert_eq!(js.program, PathBuf::from("node"));
        assert_eq!(js.args, vec!["/r/apps/core/dist/server.js".to_string()]);
        let bin = command_for(PathBuf::from("/usr/bin/freecode"), None);
        assert_eq!(bin.args, vec!["serve".to_string()]);
    }

    #[test]
    fn bundled_core_is_the_sibling_freecode_binary() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("jcode-desktop");
        assert_eq!(bundled_core(&exe), None);
        let name = if cfg!(windows) { "freecode.exe" } else { "freecode" };
        std::fs::write(dir.path().join(name), b"").unwrap();
        assert_eq!(bundled_core(&exe), Some(dir.path().join(name)));
        // A packaged binary runs as `freecode serve`, not under node.
        assert_eq!(command_for(dir.path().join(name), None).args, vec!["serve".to_string()]);
    }

    #[test]
    fn session_info_maps_core_session() {
        let info = session_info(&json!({
            "id": "s1", "title": "Fix bug", "projectPath": "/p", "status": "archived",
            "updatedAt": 2000, "lastTurnAt": 1500, "provider": "anthropic",
        }))
        .unwrap();
        assert_eq!(info.session_id, "s1");
        assert_eq!(info.title.as_deref(), Some("Fix bug"));
        assert_eq!(info.working_dir.as_deref(), Some("/p"));
        assert_eq!(info.status, "idle");
        assert!(info.archived);
        assert_eq!(info.updated_at_ms, Some(2000));
    }
}
