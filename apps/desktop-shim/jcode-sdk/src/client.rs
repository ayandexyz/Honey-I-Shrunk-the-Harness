//! Connected harness client: handshake, reply correlation, event streaming.
//!
//! Mirrors the TypeScript SDK's `JcodeClient` capability for capability. The
//! shapes differ where Rust and TS differ honestly (`Result` instead of
//! throwing, channels instead of `EventEmitter`), but every method here has a
//! counterpart there and vice versa; `parity.rs` enforces that.
//!
//! Blocking, thread-based, and `Clone`. A desktop app has a UI thread that
//! must never block on a socket and a worker that reads it forever, so the
//! client is a handle both can hold: one reader thread owns the stream and
//! fans frames out to whoever asked for them.

use crate::errors::{Error, ErrorKind, Result};
use crate::launch::{LaunchOptions, LaunchedInstance, ensure_runtime, launch_instance};
use crate::ssh::{SshConnectOptions, SshProcess, SshTransport};
use jcode_harness_api::{
    API_VERSION_MAJOR, ApiEvent, ApiRequest, ClientFrame, HistoryMessage, ModelRouteInfo,
    PermissionDecision, ServerFrame, SessionInfo, SessionToolDefinition, TextMatch,
    ToolConfiguration, api_socket_path, read_frame, write_frame,
};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{
    Receiver, RecvTimeoutError, Sender, SyncSender, TrySendError, channel, sync_channel,
};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// How a client reaches the harness.
pub struct ConnectOptions {
    /// Defaults to the resolved harness API socket path.
    pub socket_path: Option<std::path::PathBuf>,
    /// Client identity sent in the handshake, e.g. "my-app/1.0".
    pub client_name: String,
    /// How long a request waits for its reply. `None` disables the timeout.
    pub request_timeout: Option<Duration>,
    /// Start the daemon and bridge if they are not already listening.
    ///
    /// On by default: an app that only works once the user has launched two
    /// daemons by hand is indistinguishable from a broken one.
    pub ensure_runtime: bool,
    /// Desktop inline Markdown response renderer. Other clients leave false.
    pub supports_user_response: bool,
}

impl Default for ConnectOptions {
    fn default() -> Self {
        Self {
            socket_path: None,
            client_name: concat!("jcode-sdk-rs/", env!("CARGO_PKG_VERSION")).to_string(),
            request_timeout: Some(Duration::from_secs(30)),
            ensure_runtime: true,
            supports_user_response: false,
        }
    }
}

/// Options fixed when a session is created.
#[derive(Clone, Debug, Default)]
pub struct CreateSessionOptions {
    /// Working directory for the new session. Omit to use the runtime default.
    pub working_dir: Option<String>,
    /// Replace the entire assembled system prompt, not just its base text.
    ///
    /// This bypasses the default prompt and assembled instruction/context additions.
    /// `None` keeps normal prompt assembly. `Some(String::new())` explicitly
    /// overrides it with an empty prompt. Immutable after creation and persisted
    /// by the runtime for resume.
    pub system_prompt: Option<String>,
}

/// A duplex byte transport. Lets tests and future WebSockets plug in.
pub trait Transport: Send {
    /// A handle which interrupts both halves after `split`. Custom transports
    /// may omit this; native sockets provide it so Drop closes promptly.
    fn shutdown_handle(&self) -> Option<Arc<dyn Fn() + Send + Sync>> {
        todo!("jcode-sdk shim: shutdown_handle")
    }

    fn split(self: Box<Self>) -> Result<(Box<dyn BufRead + Send>, Box<dyn Write + Send>)>;
}

/// A Unix-domain socket transport, the default.
type PlatformUnixStream = jcode_transport::SyncStream;

pub struct UnixTransport(PlatformUnixStream);

impl UnixTransport {
    pub fn connect(path: &std::path::Path) -> Result<Self> {
        todo!("jcode-sdk shim: connect")
    }
}

impl Transport for UnixTransport {
    fn shutdown_handle(&self) -> Option<Arc<dyn Fn() + Send + Sync>> {
        #[cfg(unix)]
        {
            let socket = self.0.try_clone().ok()?;
            Some(Arc::new(move || {
                let _ = socket.shutdown(std::net::Shutdown::Both);
            }))
        }
        #[cfg(windows)]
        {
            let pipe = self.0.try_clone().ok()?;
            Some(Arc::new(move || {
                let _ = pipe.shutdown(std::net::Shutdown::Both);
            }))
        }
    }

    fn split(self: Box<Self>) -> Result<(Box<dyn BufRead + Send>, Box<dyn Write + Send>)> {
        let writer = self
            .0
            .try_clone()
            .map_err(|e| Error::new(ErrorKind::Transport, e.to_string()))?;
        Ok((Box::new(BufReader::new(self.0)), Box::new(writer)))
    }
}

/// A subscription to the event stream.
///
/// Streaming events are fanned out to every live subscription, so an app can
/// have one loop rendering the attached session while another waits for a
/// single acknowledgement without either stealing frames from the other.
pub struct EventStream {
    rx: Receiver<ApiEvent>,
    id: u64,
    inner: Arc<Inner>,
}

impl EventStream {
    /// Block for the next event. `None` once the connection closes.
    pub fn next(&self) -> Option<ApiEvent> {
        self.rx.recv().ok()
    }

    /// Block for the next event, up to `timeout`.
    pub fn next_timeout(&self, timeout: Duration) -> Option<ApiEvent> {
        self.rx.recv_timeout(timeout).ok()
    }
}

impl Iterator for EventStream {
    type Item = ApiEvent;
    fn next(&mut self) -> Option<ApiEvent> {
        EventStream::next(self)
    }
}

impl Drop for EventStream {
    fn drop(&mut self) {
        if let Ok(mut subs) = self.inner.subscribers.lock() {
            subs.retain(|(id, _, _)| *id != self.id);
        }
    }
}

/// Discovery and buffering controls for [`JcodeClient::global_events`].
#[derive(Debug, Clone, Copy)]
pub struct GlobalEventsOptions {
    /// How often persisted sessions are rescanned. Zero performs one scan.
    pub discovery_interval: Duration,
    /// Maximum events waiting for the consumer before the stream fails loudly.
    pub max_buffered_events: usize,
}

impl Default for GlobalEventsOptions {
    fn default() -> Self {
        Self {
            discovery_interval: Duration::from_secs(1),
            max_buffered_events: 10_000,
        }
    }
}

struct GlobalEventControl {
    stopped: AtomicBool,
    terminal_error: Mutex<Option<Error>>,
    children: Mutex<HashMap<String, JcodeClient>>,
    tx: SyncSender<ApiEvent>,
    max_buffered_events: usize,
    wake_lock: Mutex<()>,
    wake: Condvar,
}

/// Events fanned in from every persisted and newly-created session.
///
/// Delivery begins when each per-session child attaches. Ordering is preserved
/// within a session; no total order across sessions is promised. Dropping this
/// stream cancels discovery and closes all child connections.
pub struct GlobalEventStream {
    rx: Receiver<ApiEvent>,
    control: Arc<GlobalEventControl>,
    discovery: Option<std::thread::JoinHandle<()>>,
}

impl GlobalEventStream {
    /// Block for the next event, returning the terminal stream error once.
    pub fn next(&self) -> Result<Option<ApiEvent>> {
        todo!("jcode-sdk shim: next")
    }

    /// Wait up to `timeout` for an event. `Ok(None)` means timeout or shutdown.
    pub fn next_timeout(&self, timeout: Duration) -> Result<Option<ApiEvent>> {
        todo!("jcode-sdk shim: next_timeout")
    }
}

impl Iterator for GlobalEventStream {
    type Item = Result<ApiEvent>;

    fn next(&mut self) -> Option<Self::Item> {
        GlobalEventStream::next(self).transpose()
    }
}

impl Drop for GlobalEventStream {
    fn drop(&mut self) {
        stop_global_stream(&self.control, None);
        if let Some(discovery) = self.discovery.take() {
            let _ = discovery.join();
        }
    }
}

fn take_global_error(control: &GlobalEventControl) -> Option<Error> {
        todo!("jcode-sdk shim: take_global_error")
    }

fn stop_global_stream(control: &GlobalEventControl, error: Option<Error>) {
        todo!("jcode-sdk shim: stop_global_stream")
    }

/// A live subscription: (id, session filter, sink).
pub(crate) type Subscriber = (u64, Option<String>, Sender<ApiEvent>);

pub(crate) struct Inner {
    pub(crate) writer: Mutex<Box<dyn Write + Send>>,
    /// Requests waiting for their JSON-RPC reply, by id.
    pub(crate) pending: Mutex<HashMap<u64, Sender<crate::freecode::Reply>>>,
    /// Live subscriptions: (id, session filter, sink).
    pub(crate) subscribers: Mutex<Vec<Subscriber>>,
    pub(crate) next_id: AtomicU64,
    pub(crate) next_sub: AtomicU64,
    pub(crate) closed: AtomicBool,
    pub(crate) request_timeout: Option<Duration>,
    pub(crate) socket_path: std::path::PathBuf,
    pub(crate) client_name: String,
    pub(crate) native_socket: bool,
    pub(crate) ssh_process: Option<Arc<SshProcess>>,
    pub(crate) shutdown: Option<Arc<dyn Fn() + Send + Sync>>,
    pub(crate) client_handles: AtomicUsize,
    /// freecode: per-session translation state (reasoning block, cancel).
    pub(crate) sessions: Mutex<crate::freecode_events::States>,
    /// freecode: transcript returned by `session.resume`, for `get_history`.
    pub(crate) history: Mutex<HashMap<String, serde_json::Value>>,
    /// freecode: desktop-chosen `agentMode` per session (plan/build/review/
    /// explore/danger), threaded into the next `session.send`/steer. No
    /// jcode-sdk equivalent — core's own permission-mode concept.
    pub(crate) agent_modes: Mutex<HashMap<String, String>>,
    /// freecode: sticky per-session reasoning effort set via
    /// `set_reasoning_effort` (`session.setReasoningEffort`), since
    /// `config.get` only reports the process-global model, not this. Read
    /// into `ModelInfo.reasoning_effort` whenever that's republished.
    pub(crate) reasoning_efforts: Mutex<HashMap<String, String>>,
    /// freecode: true until the first session touches a just-spawned core,
    /// so exactly one `ConnectionPhase` connecting/connected pair is emitted
    /// per core process lifetime (not one per client or per attach call).
    pub(crate) connecting: AtomicBool,
}

/// Connected harness client.
///
/// Replies are correlated by the `reply_to` id the server echoes; anything
/// without one is a stream event and goes to every subscriber.
pub struct JcodeClient {
    inner: Arc<Inner>,
    /// freecode: the session this client attached to or created. Its event
    /// subscriptions are scoped to it, so one shared core's events (and
    /// session-less ones like `Error`) reach only that session's panel.
    attached: Arc<Mutex<Option<String>>>,
    subs: Arc<Mutex<Vec<u64>>>,
    ssh_options: Option<SshConnectOptions>,
    instance: Option<Arc<LaunchedInstance>>,
    /// State directory of the private instance this client owns, if any.
    pub instance_home: Option<std::path::PathBuf>,
    /// Server identity from the handshake, e.g. "jcode-harness-api-bridge/0.1.0".
    pub server: String,
    /// Capability strings advertised by the server.
    pub capabilities: Vec<String>,
}

impl Clone for JcodeClient {
    fn clone(&self) -> Self {
        self.inner.client_handles.fetch_add(1, Ordering::Relaxed);
        Self {
            inner: Arc::clone(&self.inner),
            attached: Arc::clone(&self.attached),
            subs: Arc::clone(&self.subs),
            ssh_options: self.ssh_options.clone(),
            instance: self.instance.clone(),
            instance_home: self.instance_home.clone(),
            server: self.server.clone(),
            capabilities: self.capabilities.clone(),
        }
    }
}

impl Drop for JcodeClient {
    fn drop(&mut self) {
        if self.inner.client_handles.fetch_sub(1, Ordering::AcqRel) == 1
            && let Some(shutdown) = &self.inner.shutdown
        {
            shutdown();
        }
    }
}

impl JcodeClient {
    /// freecode: bind this client and its existing subscriptions to a session.
    fn attach_to(&self, session_id: &str) {
        if let Ok(mut attached) = self.attached.lock() {
            *attached = Some(session_id.to_string());
        }
        let own = self.subs.lock().map(|s| s.clone()).unwrap_or_default();
        if let Ok(mut subs) = self.inner.subscribers.lock() {
            for (id, filter, _) in subs.iter_mut() {
                if own.contains(id) {
                    *filter = Some(session_id.to_string());
                }
            }
        }
    }

    /// freecode addition: set the agent mode (`plan`/`build`/`review`/
    /// `explore`/`danger`) the desktop wants for this session's next turn.
    /// No jcode-sdk equivalent; core reads `agentMode` off `session.send`.
    pub fn set_agent_mode(&self, session_id: &str, mode: &str) {
        crate::freecode_session::set_agent_mode(&self.inner, session_id, mode);
    }

    /// freecode addition: the mode last set for this session, if any.
    pub fn agent_mode(&self, session_id: &str) -> Option<String> {
        crate::freecode_session::agent_mode(&self.inner, session_id)
    }

    /// freecode addition: the mode the user last picked, across sessions
    /// (`config.getLastAgentMode`). No jcode-sdk equivalent — jcode has no
    /// persisted agent-mode concept.
    pub fn last_agent_mode(&self) -> Result<Option<String>> {
        crate::freecode_session::last_agent_mode(&self.inner)
    }

    /// Retain this client's shared SSH master for reconnecting independent API
    /// channels. Returns None for isolated or already closed SSH channels.
    // ponytail: freecode has no SSH transport (cut for v1, see shim contract
    // doc "No freecode equivalent" table) — every client is non-SSH, so this
    // is always None, not a todo!(). It used to panic the per-session worker
    // thread on startup for every session, local included, leaving nothing to
    // ever read the EventStream and the desktop stuck on "Responding" forever.
    #[cfg(unix)]
    pub fn shared_ssh_transport(&self) -> Option<crate::SharedSshTransport> {
        None
    }

    /// Connect to a remote shared harness using system SSH credentials/config.
    ///
    /// The remote must have `jcode api --stdio`. Dropping the last client clone
    /// kills and reaps SSH, but leaves the remote shared daemon running. This
    /// never launches a local runtime or falls back to local session data.
    pub fn connect_ssh(options: SshConnectOptions) -> Result<Self> {
        todo!("jcode-sdk shim: connect_ssh")
    }

    pub(crate) fn over_ssh(transport: SshTransport, options: SshConnectOptions) -> Result<Self> {
        todo!("jcode-sdk shim: over_ssh")
    }

    /// Start and own a private jcode instance, then connect to it.
    ///
    /// Its state and sockets are isolated from the user's interactive jcode.
    /// The last clone of this client shuts the instance down through Drop.
    pub fn launch(options: LaunchOptions) -> Result<Self> {
        // freecode: there is no private instance to own; use the shared core.
        Self::connect(ConnectOptions::default())
    }

    /// Connect to the jcode running on this machine.
    ///
    /// Use this to automate the user's own jcode: a desktop app, an editor
    /// plugin, a status dashboard. It shares the user's live sessions.
    pub fn connect(options: ConnectOptions) -> Result<Self> {
        let inner = crate::freecode::shared_core(options.request_timeout)?;
        inner.client_handles.fetch_add(1, Ordering::Relaxed);
        Ok(Self {
            inner,
            attached: Arc::new(Mutex::new(None)),
            subs: Arc::new(Mutex::new(Vec::new())),
            ssh_options: None,
            instance: None,
            instance_home: None,
            server: "freecode-core".to_string(),
            capabilities: Vec::new(),
        })
    }

    /// Connect over a caller-supplied transport. The seam tests use.
    pub fn connect_with(transport: Box<dyn Transport>, options: ConnectOptions) -> Result<Self> {
        todo!("jcode-sdk shim: connect_with")
    }

    fn over(
        transport: Box<dyn Transport>,
        options: &ConnectOptions,
        socket_path: std::path::PathBuf,
        native_socket: bool,
        ssh: Option<(SshConnectOptions, Arc<SshProcess>)>,
    ) -> Result<Self> {
        todo!("jcode-sdk shim: over")
    }

    /// The socket this client is talking to. Empty for SSH connections.
    pub fn socket_path(&self) -> &std::path::Path {
        &self.inner.socket_path
    }

    /// Whether the server advertises a capability.
    ///
    /// Capabilities are how a client learns what this particular server can do
    /// before depending on it. `permissions`, for instance, is absent from the
    /// current bridge: it never issues permission prompts, so a client that
    /// waits for one waits forever. Check rather than assume.
    pub fn supports(&self, capability: &str) -> bool {
        // freecode advertises no Jcode capabilities; gated features stay off.
        self.capabilities.iter().any(|c| c == capability)
    }

    /// Send a raw request and wait for its reply frame.
    pub fn request(&self, request: ApiRequest) -> Result<ServerFrame> {
        todo!("jcode-sdk shim: request")
    }

    fn request_with_timeout(
        &self,
        request: ApiRequest,
        timeout: Option<Duration>,
    ) -> Result<ServerFrame> {
        todo!("jcode-sdk shim: request_with_timeout")
    }

    /// Write a request without expecting a request-level reply.
    pub fn notify(&self, request: ApiRequest) -> Result<()> {
        todo!("jcode-sdk shim: notify")
    }

    fn write(&self, frame: ClientFrame) -> Result<()> {
        todo!("jcode-sdk shim: write")
    }

    fn disconnect_error(&self) -> Error {
        todo!("jcode-sdk shim: disconnect_error")
    }

    /// Send a request, failing when the server replies with an error frame.
    fn request_ok(&self, request: ApiRequest) -> Result<ServerFrame> {
        todo!("jcode-sdk shim: request_ok")
    }

    /// Subscribe to stream events, optionally filtered to one session.
    ///
    /// Frames that arrive between reads are buffered, so a consumer that does
    /// slow work in the loop body does not silently drop deltas.
    pub fn events(&self, session_id: Option<&str>) -> EventStream {
        let (tx, rx) = channel();
        let id = self.inner.next_sub.fetch_add(1, Ordering::Relaxed);
        let filter = session_id
            .map(str::to_string)
            .or_else(|| self.attached.lock().ok().and_then(|a| a.clone()));
        if let Ok(mut subs) = self.inner.subscribers.lock() {
            subs.push((id, filter, tx));
        }
        if let Ok(mut own) = self.subs.lock() {
            own.push(id);
        }
        EventStream {
            rx,
            id,
            inner: Arc::clone(&self.inner),
        }
    }

    /// Stream events from all persisted and newly-created sessions.
    ///
    /// The bridge attaches one session per connection, so this discovers
    /// sessions repeatedly, owns one native child connection per session, and
    /// fans their events into a bounded queue. A disconnected child is removed
    /// and attached again by a later discovery pass.
    pub fn global_events(&self, options: GlobalEventsOptions) -> Result<GlobalEventStream> {
        todo!("jcode-sdk shim: global_events")
    }

    // --- Curated surface -----------------------------------------------------

    pub fn list_sessions(&self) -> Result<Vec<SessionInfo>> {
        crate::freecode::list_sessions(&self.inner, None)
    }

    /// List only the newest persisted sessions, for bounded dashboard startup.
    pub fn list_sessions_limited(&self, limit: u32) -> Result<Vec<SessionInfo>> {
        crate::freecode::list_sessions(&self.inner, Some(limit))
    }

    /// Reversibly hide a session from the default list. Its transcript remains
    /// available for a later restore.
    pub fn archive_session(&self, session_id: &str) -> Result<()> {
        todo!("jcode-sdk shim: archive_session")
    }

    /// Put an archived session back in the default session list.
    pub fn restore_session(&self, session_id: &str) -> Result<()> {
        todo!("jcode-sdk shim: restore_session")
    }

    /// Automatically archive inactive sessions after `archive_after_days`.
    /// `None` disables automatic archival.
    pub fn set_retention_policy(&self, archive_after_days: Option<u32>) -> Result<()> {
        todo!("jcode-sdk shim: set_retention_policy")
    }

    /// Create a session with the normal assembled system prompt.
    pub fn create_session(&self, working_dir: Option<String>) -> Result<SessionInfo> {
        let info = crate::freecode_session::create_session(&self.inner, working_dir)?;
        // No session id exists yet to carry a "connecting" phase, so this
        // only reports the result: the core finished booting by the time
        // `session.start` returned.
        if self.inner.connecting.swap(false, Ordering::AcqRel) {
            crate::freecode::publish(
                &self.inner,
                ApiEvent::ConnectionPhase {
                    session_id: info.session_id.clone(),
                    phase: "connected".into(),
                },
                Some(&info.session_id),
            );
        }
        self.attach_to(&info.session_id);
        self.publish_model_info(&info.session_id);
        crate::freecode::publish(
            &self.inner,
            ApiEvent::Attached { session: info.clone() },
            Some(&info.session_id),
        );
        Ok(info)
    }

    /// Create a session with optional full system prompt replacement.
    /// See [`CreateSessionOptions::system_prompt`] for override semantics.
    pub fn create_session_with_options(
        &self,
        options: CreateSessionOptions,
    ) -> Result<SessionInfo> {
        todo!("jcode-sdk shim: create_session_with_options")
    }

    pub fn attach_session(&self, session_id: &str) -> Result<SessionInfo> {
        // The only path with a session id before the slow part runs: report
        // the core's own boot, not a per-turn retry (jcode has no such
        // concept here — freecode never retries a request transparently).
        let reporting = self.inner.connecting.swap(false, Ordering::AcqRel);
        if reporting {
            crate::freecode::publish(
                &self.inner,
                ApiEvent::ConnectionPhase { session_id: session_id.to_string(), phase: "connecting".into() },
                Some(session_id),
            );
        }
        let info = crate::freecode_session::attach_session(&self.inner, session_id)?;
        if reporting {
            crate::freecode::publish(
                &self.inner,
                ApiEvent::ConnectionPhase { session_id: session_id.to_string(), phase: "connected".into() },
                Some(session_id),
            );
        }
        self.attach_to(session_id);
        self.publish_model_info(session_id);
        crate::freecode::publish(
            &self.inner,
            ApiEvent::Attached { session: info.clone() },
            Some(session_id),
        );
        Ok(info)
    }

    /// Clone a session's complete persisted context into a new idle session.
    pub fn transfer_session(&self, session_id: &str) -> Result<SessionInfo> {
        Err(crate::freecode_session::unsupported("transfer_session"))
    }

    pub fn fork_session(&self, session_id: &str) -> Result<SessionInfo> {
        let info = crate::freecode_session::fork_session(&self.inner, session_id)?;
        crate::freecode::publish(
            &self.inner,
            ApiEvent::SessionForked { session: info.clone() },
            Some(&info.session_id),
        );
        Ok(info)
    }

    pub fn detach_session(&self, session_id: &str) -> Result<()> {
        // Core keeps no per-client attachment; nothing to release.
        Ok(())
    }

    /// Submit a hidden continuation without a user transcript row or accept wait.
    /// The caller, not the bridge, decides when recovery is appropriate.
    pub fn send_system_reminder(&self, session_id: &str, reminder: &str) -> Result<()> {
        Err(crate::freecode_session::unsupported("send_system_reminder"))
    }

    /// Send a user message.
    ///
    /// The harness does not reply to `send_message` at the request level: it
    /// acknowledges by emitting `message_accepted` once the agent has the
    /// message. Waiting for a reply here would always time out, so the frame
    /// is written and the acknowledgement event is awaited instead. Pass a
    /// `None` timeout for pure fire-and-forget.
    pub fn send_message(
        &self,
        session_id: &str,
        content: &str,
        images: Vec<(String, String)>,
        wait_for_accept: Option<Duration>,
    ) -> Result<()> {
        crate::freecode_session::send_message(&self.inner, session_id, content, images)
    }

    /// [`send_message`](Self::send_message) with a hidden system reminder
    /// for this turn only, such as a collection's instructions. The reminder
    /// guides the model without appearing in the visible transcript.
    pub fn send_message_with_reminder(
        &self,
        session_id: &str,
        content: &str,
        images: Vec<(String, String)>,
        system_reminder: Option<&str>,
        wait_for_accept: Option<Duration>,
    ) -> Result<()> {
        // freecode has no hidden per-turn reminder; the desktop sends one only
        // for collection instructions, which are dropped until it does.
        let _ = (system_reminder, wait_for_accept);
        crate::freecode_session::send_message(&self.inner, session_id, content, images)
    }

    pub fn cancel(&self, session_id: &str) -> Result<()> {
        crate::freecode_session::cancel(&self.inner, session_id)
    }

    pub fn soft_interrupt(&self, session_id: &str, content: &str, urgent: bool) -> Result<()> {
        todo!("jcode-sdk shim: soft_interrupt")
    }

    /// Inject text and image attachments at the next safe point without cancelling.
    pub fn soft_interrupt_with_images(
        &self,
        session_id: &str,
        content: &str,
        images: Vec<(String, String)>,
        urgent: bool,
    ) -> Result<()> {
        let _ = urgent;
        crate::freecode_session::steer(&self.inner, session_id, content, images)
    }

    /// Queue a soft interrupt tagged with an opaque `client_id`.
    ///
    /// The id comes back in [`ApiEvent::SoftInterruptInjected`] when the model
    /// receives the message, and [`Self::cancel_soft_interrupt`] can take it
    /// back before then. Needs the `soft_interrupt_ids` capability; an older
    /// server accepts the message but drops the id.
    pub fn soft_interrupt_with_id(
        &self,
        session_id: &str,
        content: &str,
        images: Vec<(String, String)>,
        urgent: bool,
        client_id: Option<&str>,
    ) -> Result<()> {
        todo!("jcode-sdk shim: soft_interrupt_with_id")
    }

    pub fn get_history(&self, session_id: &str) -> Result<Vec<HistoryMessage>> {
        Ok(crate::freecode_session::history(&self.inner, session_id)?.0)
    }

    pub fn get_history_with_images(
        &self,
        session_id: &str,
    ) -> Result<(Vec<HistoryMessage>, Vec<jcode_harness_api::RenderedImage>)> {
        crate::freecode_session::history(&self.inner, session_id)
    }

    pub fn peek_session(
        &self,
        session_id: &str,
        limit: Option<u32>,
    ) -> Result<Vec<HistoryMessage>> {
        todo!("jcode-sdk shim: peek_session")
    }

    pub fn clear(&self, session_id: &str) -> Result<()> {
        Err(crate::freecode_session::unsupported("clear"))
    }

    pub fn rewind(&self, session_id: &str, message_index: usize) -> Result<()> {
        Err(crate::freecode_session::unsupported("rewind"))
    }

    pub fn respond_to_permission(
        &self,
        session_id: &str,
        request_id: &str,
        decision: PermissionDecision,
    ) -> Result<()> {
        let _ = session_id;
        crate::freecode_session::respond_to_permission(&self.inner, request_id, decision)
    }

    /// Models this session can switch to, and which one is serving it.
    pub fn list_models(&self, session_id: &str) -> Result<(Vec<String>, Option<String>)> {
        todo!("jcode-sdk shim: list_models")
    }

    /// Runtime identity, route catalog, protocol metadata, and a live health
    /// check for a session.
    pub fn runtime_command(
        &self,
        session_id: &str,
        command: jcode_harness_api::RuntimeCommand,
        args: Vec<String>,
    ) -> Result<jcode_harness_api::RuntimeCommandOutput> {
        Err(crate::freecode_session::unsupported("runtime_command"))
    }

    pub fn get_runtime_info(&self, session_id: &str) -> Result<RuntimeInfo> {
        crate::freecode_session::runtime_info(&self.inner, session_id)
    }

    /// Persist an API key in jcode's owner-only provider store and hot-reload
    /// provider credentials.
    pub fn set_api_key(&self, provider: &str, api_key: &str) -> Result<()> {
        Err(crate::freecode_session::unsupported("set_api_key"))
    }

    /// Reload credentials saved by an out-of-band OAuth login. This does not
    /// send a chat message or transport any credential material.
    pub fn notify_auth_changed(&self, provider: &str) -> Result<()> {
        Err(crate::freecode_session::unsupported("notify_auth_changed"))
    }

    /// Tell the daemon a banked usage reset was redeemed for one subscription
    /// login (`claude` or `openai`), so it refetches quota instead of keeping a
    /// pre-reset cooldown. Carries no credentials and never redeems anything.
    pub fn invalidate_usage(&self, provider: &str, account_label: Option<&str>) -> Result<()> {
        Err(crate::freecode_session::unsupported("invalidate_usage"))
    }

    /// Remove a persisted API-key credential and hot-reload provider
    /// credentials.
    pub fn clear_api_key(&self, provider: &str) -> Result<()> {
        todo!("jcode-sdk shim: clear_api_key")
    }

    /// Read one UTF-8 file under the session working directory.
    pub fn read_file(
        &self,
        session_id: &str,
        path: &str,
        max_bytes: Option<u64>,
    ) -> Result<FileContent> {
        todo!("jcode-sdk shim: read_file")
    }

    /// Find files by case-insensitive path substring under the session root.
    pub fn find_files(
        &self,
        session_id: &str,
        query: &str,
        limit: Option<u32>,
    ) -> Result<Vec<String>> {
        todo!("jcode-sdk shim: find_files")
    }

    /// Search UTF-8 files under the session root for a literal string.
    pub fn search_text(
        &self,
        session_id: &str,
        query: &str,
        options: SearchTextOptions,
    ) -> Result<Vec<TextMatch>> {
        todo!("jcode-sdk shim: search_text")
    }

    /// Read safe filesystem metadata for a path under the session root.
    /// The session's persisted todo state for the auto-poke and quality-gate
    /// policy. Requires the `todo_state` capability.
    pub fn todo_state(&self, session_id: &str) -> Result<jcode_todo_policy::TodoSnapshot> {
        Err(crate::freecode_session::unsupported("todo_state"))
    }

    /// Apply a follow-up decision's persistent effects. A no-op when empty.
    pub fn ack_todo_follow_up(
        &self,
        session_id: &str,
        effects: jcode_todo_policy::TodoEffects,
    ) -> Result<()> {
        Err(crate::freecode_session::unsupported("ack_todo_follow_up"))
    }

    pub fn file_status(&self, session_id: &str, path: &str) -> Result<FileStatus> {
        todo!("jcode-sdk shim: file_status")
    }

    /// Configure the tools available to a session before starting a turn.
    ///
    /// Custom tool invocations arrive as [`ApiEvent::ToolCall`] on [`Self::events`].
    /// Subscribe before sending a message and answer each invocation with
    /// [`Self::submit_tool_result`]. The SDK does not execute custom tools itself.
    pub fn configure_tools(&self, session_id: &str, tools: ToolConfiguration) -> Result<()> {
        todo!("jcode-sdk shim: configure_tools")
    }

    /// List the effective tool definitions available to a session.
    pub fn list_tools(&self, session_id: &str) -> Result<Vec<SessionToolDefinition>> {
        todo!("jcode-sdk shim: list_tools")
    }

    /// Complete a custom [`ApiEvent::ToolCall`] using its session and call ids.
    ///
    /// Pass textual output (serialize structured results as JSON) and `None`
    /// for success, or `Some(message)` to report a tool execution failure.
    pub fn submit_tool_result(
        &self,
        session_id: &str,
        call_id: &str,
        output: &str,
        error: Option<String>,
    ) -> Result<()> {
        todo!("jcode-sdk shim: submit_tool_result")
    }

    /// Switch the session to a different model. `model` is an id from
    /// `list_models`.
    pub fn set_model(&self, session_id: &str, model: &str) -> Result<()> {
        crate::freecode_session::set_model(&self.inner, model)?;
        self.publish_model_info(session_id);
        Ok(())
    }

    /// Best-effort: a failed lookup just skips the event, same as other
    /// synthesized-event call sites in this file.
    fn publish_model_info(&self, session_id: &str) {
        if let Ok(event) = crate::freecode_session::model_info_event(&self.inner, session_id) {
            crate::freecode::publish(&self.inner, event, Some(session_id));
        }
    }

    /// Set how much the model deliberates before answering. The accepted set
    /// is per-provider, so this takes a string rather than a union that would
    /// go stale.
    pub fn set_reasoning_effort(&self, session_id: &str, effort: &str) -> Result<()> {
        crate::freecode_session::set_reasoning_effort(&self.inner, session_id, effort)?;
        self.publish_model_info(session_id);
        Ok(())
    }

    /// Schedule compaction of the transcript so far, freeing context. Not
    /// synchronous: returning means the request was accepted.
    pub fn compact(&self, session_id: &str) -> Result<String> {
        crate::freecode_session::compact(&self.inner, session_id)
    }

    /// Set a session's title. `None` restores the generated one.
    pub fn rename_session(&self, session_id: &str, title: Option<String>) -> Result<()> {
        crate::freecode_session::rename_session(&self.inner, session_id, title)
    }

    /// Bookmark or unbookmark a session. A label also becomes its title.
    pub fn set_session_saved(
        &self,
        session_id: &str,
        saved: bool,
        label: Option<String>,
    ) -> Result<()> {
        crate::freecode_session::set_session_saved(&self.inner, session_id, saved, label)
    }

    /// Report a user action in an agent applet instance.
    pub fn applet_action(
        &self,
        session_id: &str,
        instance: &str,
        action: jcode_applet_types::Action,
        state: serde_json::Value,
        source_key: Option<String>,
    ) -> Result<()> {
        Err(crate::freecode_session::unsupported("applet_action"))
    }

    /// Close an agent applet instance. The agent is not woken.
    pub fn close_applet(&self, session_id: &str, instance: &str) -> Result<()> {
        Err(crate::freecode_session::unsupported("close_applet"))
    }

    /// Restore the history the last `rewind` removed.
    pub fn rewind_undo(&self, session_id: &str) -> Result<()> {
        Err(crate::freecode_session::unsupported("rewind_undo"))
    }

    /// Drop soft interrupts that are queued but not yet delivered.
    pub fn cancel_soft_interrupts(&self, session_id: &str) -> Result<()> {
        todo!("jcode-sdk shim: cancel_soft_interrupts")
    }

    /// Take back specific queued soft interrupts by `client_id`.
    ///
    /// Returns `(cancelled, not_queued)`. The server decides against injection
    /// atomically, so an id in `cancelled` was never seen by the model, and an
    /// id in `not_queued` was already delivered (or never queued).
    pub fn cancel_soft_interrupts_by_id(
        &self,
        session_id: &str,
        client_ids: &[&str],
    ) -> Result<(Vec<String>, Vec<String>)> {
        todo!("jcode-sdk shim: cancel_soft_interrupts_by_id")
    }

    /// Take back one queued soft interrupt. `true` means it was removed before
    /// the model saw it, `false` that it was already delivered (or unknown).
    pub fn cancel_soft_interrupt(&self, session_id: &str, client_id: &str) -> Result<bool> {
        todo!("jcode-sdk shim: cancel_soft_interrupt")
    }

    /// Move the running tool call to the background (the TUI's Alt+B).
    pub fn background_tool(&self, session_id: &str) -> Result<()> {
        Err(crate::freecode_session::unsupported("background_tool"))
    }

    /// Move the running tool call to the background and report what moved.
    ///
    /// Returns `(moved, tool_call_id)`. A server without the
    /// `background_tool_result` capability answers only `Ok`, reported here as
    /// `(false, None)` even if a tool was moved.
    pub fn background_tool_result(&self, session_id: &str) -> Result<(bool, Option<String>)> {
        todo!("jcode-sdk shim: background_tool_result")
    }

    pub fn ping(&self) -> Result<()> {
        crate::freecode::call(&self.inner, "config.get", serde_json::json!({})).map(|_| ())
    }

    /// Send a message and collect the assistant reply until the turn ends.
    ///
    /// The convenience path for scripts: one call in, the text and tool calls
    /// of one turn out. Streaming consumers should use `events()` instead.
    pub fn run(&self, session_id: &str, content: &str, options: RunOptions) -> Result<TurnResult> {
        todo!("jcode-sdk shim: run")
    }

    /// Whether the connection has been closed or lost.
    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(Ordering::Acquire)
    }
}

mod types;
pub use types::*;

#[derive(Default)]
struct TextCollector {
    parts: Vec<(AssistantTextMessage, bool)>,
}

impl TextCollector {
    fn index(&self, id: &Option<String>) -> Option<usize> {
        todo!("jcode-sdk shim: index")
    }

    fn message(&mut self, id: Option<String>) -> &mut (AssistantTextMessage, bool) {
        todo!("jcode-sdk shim: message")
    }

    fn finish(self, result: &mut TurnResult) {
        todo!("jcode-sdk shim: finish")
    }
}

fn discover_global_sessions(
    parent: JcodeClient,
    control: Arc<GlobalEventControl>,
    interval: Duration,
) {
        todo!("jcode-sdk shim: discover_global_sessions")
    }

fn start_global_child(parent: &JcodeClient, control: &Arc<GlobalEventControl>, session_id: String) {
        todo!("jcode-sdk shim: start_global_child")
    }

/// The reader thread: correlates replies, fans stream events out.
fn spawn_reader(inner: Arc<Inner>, mut reader: Box<dyn BufRead + Send>) {
        todo!("jcode-sdk shim: spawn_reader")
    }

/// The session an event belongs to, when it names one.
pub(crate) fn event_session(event: &ApiEvent) -> Option<&str> {
    use ApiEvent::*;
    match event {
        TextDelta { session_id, .. }
        | TextDone { session_id, .. }
        | TextReplace { session_id, .. }
        | ReasoningDelta { session_id, .. }
        | ReasoningDone { session_id, .. }
        | ToolStart { session_id, .. }
        | ToolInputDelta { session_id, .. }
        | ToolExec { session_id, .. }
        | ToolDone { session_id, .. }
        | ToolCall { session_id, .. }
        | Tools { session_id, .. }
        | SidePanelState { session_id, .. }
        | TokenUsage { session_id, .. }
        | KvCacheMiss { session_id, .. }
        | TurnDone { session_id, .. }
        | SoftInterruptInjected { session_id, .. }
        | TurnStopped { session_id, .. }
        | BackgroundProgress { session_id, .. }
        | MessageAccepted { session_id, .. }
        | PermissionRequest { session_id, .. }
        | SessionStatus { session_id, .. }
        | SessionRecovery { session_id, .. }
        | ModelInfo { session_id, .. }
        | RuntimeInfo { session_id, .. }
        | ConnectionPhase { session_id, .. }
        | Models { session_id, .. }
        | Compacted { session_id, .. }
        | SessionRenamed { session_id, .. }
        | History { session_id, .. } => Some(session_id.as_str()),
        Attached { session } => Some(session.session_id.as_str()),
        _ => None,
    }
}

fn closed_error() -> Error {
        todo!("jcode-sdk shim: closed_error")
    }

fn poisoned<T>(_: std::sync::PoisonError<T>) -> Error {
        todo!("jcode-sdk shim: poisoned")
    }

fn unexpected(want: &str, got: &ApiEvent) -> Error {
        todo!("jcode-sdk shim: unexpected")
    }

/// The wire name of a request, for error text.
fn request_name(request: &ApiRequest) -> String {
        todo!("jcode-sdk shim: request_name")
    }
