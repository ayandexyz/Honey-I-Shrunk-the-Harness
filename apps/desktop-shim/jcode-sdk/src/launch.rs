//! Runtime startup and private jcode instances.
//!
//! [`ensure_runtime`] attaches applications to the user's shared runtime.
//! [`launch_instance`] instead creates an isolated runtime directory and state
//! home which the returned owner tears down on drop.

use crate::errors::{Error, ErrorKind, Result};
#[cfg(unix)]
use serde_json::Value;
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[cfg(unix)]
#[path = "launch_upgrade.rs"]
mod shared_upgrade;

const CREDENTIAL_FILES: &[&str] = &[
    "auth.json",
    "openai-auth.json",
    "antigravity_oauth.json",
    "gemini_oauth.json",
    "google_oauth.json",
    "google_credentials.json",
    "config.toml",
];

const EXTERNAL_CREDENTIAL_FILES: &[&str] = &[
    ".claude/.credentials.json",
    ".codex/auth.json",
    ".gemini/oauth_creds.json",
    ".cursor/auth.json",
    ".config/cursor/auth.json",
    "AppData/Roaming/Cursor/auth.json",
    ".config/Cursor/User/globalStorage/state.vscdb",
    ".config/cursor/User/globalStorage/state.vscdb",
    "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
    "Library/Application Support/cursor/User/globalStorage/state.vscdb",
    "AppData/Roaming/Cursor/User/globalStorage/state.vscdb",
    "AppData/Roaming/cursor/User/globalStorage/state.vscdb",
    ".config/github-copilot/hosts.json",
    ".config/github-copilot/apps.json",
    ".copilot/config.json",
    ".hermes/auth.json",
    ".pi/agent/auth.json",
    ".openclaw/agent/auth.json",
    ".openclaw/credentials/oauth.json",
    ".local/share/opencode/auth.json",
];

/// Operator ownership mode for autonomous wake requests.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum WakeMode {
    #[default]
    Internal,
    External,
}

impl WakeMode {
    fn as_str(self) -> &'static str {
        todo!("jcode-sdk shim: as_str")
    }
}

/// Options for starting a private jcode instance.
pub struct LaunchOptions {
    /// State directory for the instance. A temporary, drop-cleaned directory is
    /// used when omitted; an explicit directory is persistent.
    pub jcode_home: Option<PathBuf>,
    /// Working directory inherited by sessions created in the instance.
    pub working_dir: Option<PathBuf>,
    /// Share the user's provider login files. Enabled by default.
    pub inherit_logins: bool,
    /// jcode executable. Defaults to `jcode` on `$PATH`.
    pub binary: Option<PathBuf>,
    /// Extra environment variables for the private instance.
    pub env: HashMap<OsString, OsString>,
    /// Default model for spawned swarm workers, unless overridden per spawn.
    /// `inherit` defaults to the coordinator's model and auth route.
    /// This is applied as the operator-level
    /// `JCODE_SWARM_MODEL` override and takes precedence over `env`.
    pub swarm_model: Option<String>,
    /// Who executes autonomous wake requests. Applied as the operator-level
    /// `JCODE_WAKE_MODE` override and takes precedence over `env`.
    pub wake_mode: Option<WakeMode>,
    /// How long to wait for the API socket to accept connections.
    pub startup_timeout: Duration,
    /// Forward the bridge's stderr instead of capturing it for startup errors.
    pub inherit_stderr: bool,
    /// Maximum time spent removing a temporary home which is still being
    /// written by background work.
    pub cleanup_timeout: Duration,
    /// Client identity used by [`crate::JcodeClient::launch`].
    pub client_name: String,
    /// Request timeout used by [`crate::JcodeClient::launch`].
    pub request_timeout: Option<Duration>,
    /// Socket override used only by [`ensure_runtime`]. Kept here for backwards
    /// compatibility with the original shared-runtime launcher.
    pub api_socket: Option<PathBuf>,
    /// Shared-runtime startup timeout used only by [`ensure_runtime`].
    ///
    /// This retains the original Rust SDK field while `startup_timeout` matches
    /// private-instance launch terminology.
    pub start_timeout: Duration,
}

impl Default for LaunchOptions {
    fn default() -> Self {
        Self {
            jcode_home: None,
            working_dir: None,
            inherit_logins: true,
            binary: None,
            env: HashMap::new(),
            swarm_model: None,
            wake_mode: None,
            startup_timeout: Duration::from_secs(30),
            inherit_stderr: false,
            cleanup_timeout: Duration::from_secs(30),
            client_name: concat!("jcode-sdk-rs/", env!("CARGO_PKG_VERSION")).to_string(),
            request_timeout: Some(Duration::from_secs(30)),
            api_socket: None,
            start_timeout: Duration::from_secs(30),
        }
    }
}

/// A running private instance. Dropping it stops both bridge and daemon, then
/// removes an SDK-created temporary home. Caller-supplied homes are preserved.
pub struct LaunchedInstance {
    pub socket_path: PathBuf,
    pub jcode_home: PathBuf,
    runtime_dir: PathBuf,
    child: Mutex<Option<Child>>,
    ephemeral: bool,
    cleanup_timeout: Duration,
    stopped: AtomicBool,
}

impl LaunchedInstance {
    fn shutdown(&self) {
        todo!("jcode-sdk shim: shutdown")
    }
}

impl Drop for LaunchedInstance {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Start an isolated daemon and API bridge and return once its socket accepts.
/// The instance runs the launching binary and never auto-updates, so it stays on that jcode version.
pub fn launch_instance(options: &LaunchOptions) -> Result<LaunchedInstance> {
        todo!("jcode-sdk shim: launch_instance")
    }

/// Resolve the user's normal jcode home before a private instance overrides it.
pub fn user_jcode_home() -> PathBuf {
    std::env::var_os("JCODE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".jcode"))
}

/// Share rotating login records with an instance and copy mutable config.
/// Returns the instance-relative paths which were inherited.
pub fn inherit_credentials(from_home: &Path, to_home: &Path) -> Result<Vec<PathBuf>> {
        todo!("jcode-sdk shim: inherit_credentials")
    }

fn link_credential_file(source: &Path, root: &Path, relative: &Path) -> Result<()> {
        todo!("jcode-sdk shim: link_credential_file")
    }

#[cfg(unix)]
fn link_file(source: &Path, destination: &Path) -> Result<()> {
        todo!("jcode-sdk shim: link_file")
    }

#[cfg(windows)]
fn link_file(source: &Path, destination: &Path) -> Result<()> {
        todo!("jcode-sdk shim: link_file")
    }

fn ensure_instance_directory(root: &Path, relative: &Path) -> Result<PathBuf> {
        todo!("jcode-sdk shim: ensure_instance_directory")
    }

/// Progress while a shared runtime comes up.
pub type Progress<'a> = dyn Fn(&str) + 'a;

/// Whether anything is listening on a socket path.
pub fn socket_accepts(path: &Path) -> bool {
        // No Jcode daemon socket exists; the harness must never try to revive one.
        false
    }

/// Locate a sibling executable next to our own, falling back to `$PATH`.
fn sibling_exe(name: &str) -> PathBuf {
        todo!("jcode-sdk shim: sibling_exe")
    }

fn sibling_exe_next_to(current: Option<&Path>, name: &str) -> PathBuf {
        todo!("jcode-sdk shim: sibling_exe_next_to")
    }

/// Start the user's shared daemon and API bridge if necessary.
pub fn ensure_runtime(options: &LaunchOptions, progress: &Progress<'_>) -> Result<()> {
        // freecode: core is spawned on first connect; only check it can be found.
        crate::freecode::locate_core().map(|_| ())
    }

fn spawn_detached(program: &Path, args: &[&str]) -> std::io::Result<()> {
        todo!("jcode-sdk shim: spawn_detached")
    }

/// Block until `path` accepts connections, or the timeout expires.
pub fn wait_for_socket(path: &Path, what: &str, timeout: Duration) -> Result<()> {
        todo!("jcode-sdk shim: wait_for_socket")
    }

#[cfg(unix)]
fn read_daemon_pid(home: &Path, runtime_dir: &Path) -> Option<i32> {
        todo!("jcode-sdk shim: read_daemon_pid")
    }

#[cfg(unix)]
fn stop_instance_daemon(home: &Path, runtime_dir: &Path) {
        todo!("jcode-sdk shim: stop_instance_daemon")
    }

/// Pid of a daemon already registered for this runtime directory before the
/// launch started. A failed launch must not stop that daemon.
#[cfg(unix)]
fn registered_daemon_pid(home: &Path, runtime_dir: &Path) -> Option<i32> {
        todo!("jcode-sdk shim: registered_daemon_pid")
    }

/// Stop the daemon a failed launch registered. A daemon that was already
/// registered before the launch belongs to someone else and is left alone.
#[cfg(unix)]
fn stop_daemon_started_by_failed_launch(
    home: &Path,
    runtime_dir: &Path,
    registered_before: Option<i32>,
) {
        todo!("jcode-sdk shim: stop_daemon_started_by_failed_launch")
    }

#[cfg(unix)]
fn stop_daemon_pid(pid: i32) {
        todo!("jcode-sdk shim: stop_daemon_pid")
    }

#[cfg(not(unix))]
fn registered_daemon_pid(_home: &Path, _runtime_dir: &Path) -> Option<i32> {
        todo!("jcode-sdk shim: registered_daemon_pid")
    }

#[cfg(not(unix))]
fn stop_daemon_started_by_failed_launch(
    _home: &Path,
    _runtime_dir: &Path,
    _registered_before: Option<i32>,
) {
        todo!("jcode-sdk shim: stop_daemon_started_by_failed_launch")
    }

#[cfg(not(unix))]
fn stop_instance_daemon(_home: &Path, _runtime_dir: &Path) {
        todo!("jcode-sdk shim: stop_instance_daemon")
    }

#[cfg(unix)]
fn signal_process_group(pid: i32, signal: i32) {
        todo!("jcode-sdk shim: signal_process_group")
    }

#[cfg(unix)]
fn process_exists(pid: i32) -> bool {
        todo!("jcode-sdk shim: process_exists")
    }

#[cfg(unix)]
fn terminate_child(child: &mut Child) {
        todo!("jcode-sdk shim: terminate_child")
    }

#[cfg(not(unix))]
fn terminate_child(child: &mut Child) {
        todo!("jcode-sdk shim: terminate_child")
    }

fn remove_ephemeral_home(home: &Path, timeout: Duration) {
        todo!("jcode-sdk shim: remove_ephemeral_home")
    }

fn stderr_suffix(stderr: &str) -> String {
        todo!("jcode-sdk shim: stderr_suffix")
    }

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Resolve the user's platform jcode config directory.
pub fn user_app_config_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        home_dir().join("Library/Application Support/jcode")
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join("AppData/Roaming"))
            .join("jcode")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".config"))
            .join("jcode")
    }
}

#[cfg(unix)]
fn set_owner_only_dir(path: &Path) -> Result<()> {
        todo!("jcode-sdk shim: set_owner_only_dir")
    }

#[cfg(unix)]
fn set_owner_only_file(path: &Path) -> Result<()> {
        todo!("jcode-sdk shim: set_owner_only_file")
    }

#[cfg(not(unix))]
fn set_owner_only_dir(_path: &Path) -> Result<()> {
        todo!("jcode-sdk shim: set_owner_only_dir")
    }

#[cfg(not(unix))]
fn set_owner_only_file(_path: &Path) -> Result<()> {
        todo!("jcode-sdk shim: set_owner_only_file")
    }

fn launch_io(error: std::io::Error) -> Error {
        todo!("jcode-sdk shim: launch_io")
    }

#[cfg(test)]
mod executable_tests {
    use super::*;

    #[test]
    fn sibling_executable_uses_platform_suffix_in_bundle_with_spaces() {
        todo!("jcode-sdk shim: sibling_executable_uses_platform_suffix_in_bundle_with_spaces")
    }

    #[test]
    fn sibling_executable_fallback_uses_platform_suffix() {
        todo!("jcode-sdk shim: sibling_executable_fallback_uses_platform_suffix")
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn swarm_model_reaches_runtime_and_overrides_generic_environment() {
        todo!("jcode-sdk shim: swarm_model_reaches_runtime_and_overrides_generic_environment")
    }

    #[cfg(unix)]
    #[test]
    fn wake_mode_reaches_runtime_and_overrides_generic_environment() {
        todo!("jcode-sdk shim: wake_mode_reaches_runtime_and_overrides_generic_environment")
    }

    #[cfg(unix)]
    #[test]
    fn private_instances_disable_auto_update() {
        todo!("jcode-sdk shim: private_instances_disable_auto_update")
    }

    #[test]
    fn dropping_an_ephemeral_instance_stops_its_bridge_and_removes_its_home() {
        todo!("jcode-sdk shim: dropping_an_ephemeral_instance_stops_its_bridge_and_removes_its_home")
    }

    /// A daemon owned by the test. Its reaper thread reaps the child as soon as it
    /// exits, so a stopped daemon is never left as a zombie that still answers
    /// `kill(pid, 0)`. The reaper runs on its own thread because `launch_instance`
    /// stops daemons synchronously, before it returns to the test.
    struct StandInDaemon {
        pid: i32,
        exited: std::sync::mpsc::Receiver<()>,
    }

    impl StandInDaemon {
        fn spawn() -> Self {
        todo!("jcode-sdk shim: spawn")
    }

        fn is_running(&self) -> bool {
        todo!("jcode-sdk shim: is_running")
    }

        fn wait_for_exit(&self, timeout: Duration) -> bool {
        todo!("jcode-sdk shim: wait_for_exit")
    }
    }

    impl Drop for StandInDaemon {
        fn drop(&mut self) {
            if self.is_running() {
                // SAFETY: the reaper has not reaped the child yet, so this pid still names it.
                unsafe {
                    libc::kill(self.pid, libc::SIGKILL);
                }
            }
        }
    }

    /// Registers the stand-in daemon for this runtime, as a real bridge's daemon would.
    const REGISTER_DAEMON: &str = r#"printf '{"x":{"socket":"%s","pid":%s}}' "$JCODE_RUNTIME_DIR/jcode.sock" "$DAEMON_PID" > "$JCODE_HOME/servers.json""#;

    /// Launch a fake `jcode` whose body is `script`; `DAEMON_PID` names `daemon`.
    fn launch_with_fake_runtime(
        sandbox: &Path,
        script: &str,
        daemon: &StandInDaemon,
        jcode_home: Option<PathBuf>,
        startup_timeout: Duration,
    ) -> Result<LaunchedInstance> {
        todo!("jcode-sdk shim: launch_with_fake_runtime")
    }

    #[test]
    fn failed_startup_stops_daemon_when_jcode_exits() {
        todo!("jcode-sdk shim: failed_startup_stops_daemon_when_jcode_exits")
    }

    #[test]
    fn failed_startup_stops_daemon_when_socket_never_appears() {
        todo!("jcode-sdk shim: failed_startup_stops_daemon_when_socket_never_appears")
    }

    #[test]
    fn failed_startup_leaves_a_daemon_registered_before_the_launch_running() {
        todo!("jcode-sdk shim: failed_startup_leaves_a_daemon_registered_before_the_launch_running")
    }
}
