//! Slash-command catalog. **Visible** (`public`) entries are kept to exactly
//! freecode's own TUI surface (`apps/tui/src/commands/built-in.ts`), so the
//! `/` picker and `/help` never advertise a feature freecode doesn't have.
//! Desktop-only extras (session save/rename, theming, git/release tooling,
//! debug/screenshot tools, the account picker, …) still work if typed —
//! `registered_command()` does not filter on `hidden` — but are `hidden` so
//! they don't clutter the picker with things that look like missing
//! freecode functionality. A command with no freecode backend to dispatch
//! to at all is not registered here even hidden — see
//! `jcode-sdk/src/client.rs`'s `runtime_command` for which ones are wired.

#[derive(Clone, Copy)]
pub(crate) struct RegisteredCommand {
    pub(crate) name: &'static str,
    pub(crate) help: &'static str,
    pub(crate) hidden: bool,
}

impl RegisteredCommand {
    const fn public(name: &'static str, help: &'static str) -> Self {
        Self {
            name,
            help,
            hidden: false,
        }
    }

    const fn hidden(name: &'static str, help: &'static str) -> Self {
        Self {
            name,
            help,
            hidden: true,
        }
    }
}

pub(crate) const REGISTERED_COMMANDS: &[RegisteredCommand] = &[
    RegisteredCommand::public("/help", "Show help and keyboard shortcuts"),
    RegisteredCommand::hidden("/?", "Alias for /help"),
    RegisteredCommand::hidden("/commands", "Alias for /help"),
    RegisteredCommand::public("/model", "List or switch models"),
    RegisteredCommand::hidden("/models", "Alias for /model"),
    RegisteredCommand::public("/agents", "Subagents spawned in this session — watch one work"),
    RegisteredCommand::hidden(
        "/swarm-prompt",
        "Open the active swarm routing prompt in your editor",
    ),
    RegisteredCommand::hidden("/observe", "Show the latest tool context in the side panel"),
    RegisteredCommand::hidden("/todos", "Show the session todo list as a card in the chat"),
    RegisteredCommand::hidden("/todo", "Alias for /todos"),
    RegisteredCommand::hidden("/splitview", "Mirror the current chat in the side panel"),
    RegisteredCommand::hidden("/split-view", "Alias for /splitview"),
    RegisteredCommand::hidden("/btw", "Ask a side question in the side panel"),
    RegisteredCommand::hidden("/ssh", "Connect to a remote machine using system SSH"),
    RegisteredCommand::hidden("/git", "Show git status for the session working directory"),
    RegisteredCommand::hidden("/colors", "List or change Desktop color themes"),
    RegisteredCommand::hidden("/color", "Alias for /colors"),
    RegisteredCommand::hidden("/hotkeys", "List registered Desktop hotkeys and contexts"),
    RegisteredCommand::hidden("/terminal-setup", "Explain Desktop's built-in terminal setup"),
    RegisteredCommand::hidden("/commit", "Make logical commits from current changes"),
    RegisteredCommand::hidden(
        "/commit-push",
        "Make logical commits from current changes, then push",
    ),
    RegisteredCommand::hidden("/commit-and-push", "Alias for /commit-push"),
    RegisteredCommand::hidden(
        "/publish",
        "Desktop selfdev: commit, push, release, and publish, tracked in a new panel",
    ),
    RegisteredCommand::hidden(
        "/fast-release",
        "Open Desktop's standard validated publish tracker",
    ),
    RegisteredCommand::hidden(
        "/fast-macos-release",
        "Open Desktop's cross-platform publish tracker",
    ),
    RegisteredCommand::hidden(
        "/remote-release",
        "Open Desktop's publish tracker with CI-managed platform builds",
    ),
    RegisteredCommand::hidden("/cut-release", "Alias for /fast-release"),
    RegisteredCommand::hidden("/commit-push-release", "Alias for /cut-release"),
    RegisteredCommand::hidden(
        "/triage",
        "Triage new GitHub issues and autonomously fix the safe ones",
    ),
    RegisteredCommand::hidden("/transcript", "Open the current session transcript file"),
    RegisteredCommand::public(
        "/effort",
        "Set reasoning effort (none/minimal/low/medium/high/xhigh/max)",
    ),
    RegisteredCommand::hidden("/alignment", "Show/change default text alignment"),
    RegisteredCommand::hidden(
        "/compact-notifications",
        "Show/toggle single-line swarm/file-activity notifications",
    ),
    RegisteredCommand::hidden(
        "/show-agentgrep-output",
        "Show/toggle full agentgrep search output inline in chat",
    ),
    RegisteredCommand::hidden(
        "/tool-call-details",
        "Show/toggle dimmed technical details on tool rows with an intent",
    ),
    RegisteredCommand::hidden(
        "/thinking-display",
        "Show/hide the model's thinking text (off/full/current)",
    ),
    RegisteredCommand::hidden("/thinking", "Alias for /thinking-display"),
    RegisteredCommand::hidden("/reasoning", "Alias for /thinking-display"),
    RegisteredCommand::hidden("/cancel", "Cancel the current prompt or operation"),
    RegisteredCommand::public("/clear", "Clear conversation history"),
    RegisteredCommand::hidden("/cls", "Clear the view only, keeping context"),
    RegisteredCommand::hidden("/clear-view", "Alias for /cls"),
    RegisteredCommand::public("/rewind", "Rewind conversation to previous message"),
    RegisteredCommand::hidden("/poke", "Poke model to resume with incomplete todos"),
    RegisteredCommand::hidden("/plan", "Create a plan-only response as a plan card"),
    RegisteredCommand::hidden("/improve", "Autonomously improve the repository"),
    RegisteredCommand::hidden("/refactor", "Run a safe refactor loop"),
    RegisteredCommand::public("/compact", "Compact context"),
    RegisteredCommand::hidden("/fix", "Recover when the model cannot continue"),
    RegisteredCommand::hidden("/dictate", "Run configured external dictation command"),
    RegisteredCommand::hidden("/dictation", "Alias for /dictate"),
    RegisteredCommand::hidden("/memory", "Show or toggle memory settings (/memory on|off)"),
    RegisteredCommand::hidden("/test", "Verify a claim/current changes with layered tests"),
    RegisteredCommand::public(
        "/night",
        "Overnight runs — read a morning report, stop a running night",
    ),
    RegisteredCommand::public("/context", "Show what is occupying the context window"),
    RegisteredCommand::public("/skills", "Show loaded skills (global + project)"),
    RegisteredCommand::hidden("/version", "Show current version"),
    RegisteredCommand::hidden("/changelog", "Show recent changes in this build"),
    RegisteredCommand::hidden("/applets", "Open the applet component showcase"),
    RegisteredCommand::hidden("/info", "Show session info and tokens"),
    RegisteredCommand::hidden(
        "/reset",
        "Review and confirm an OpenAI or Claude usage limit reset",
    ),
    RegisteredCommand::public("/usage", "Show connected provider usage limits"),
    RegisteredCommand::hidden("/support", "Email support with diagnostics prefilled"),
    RegisteredCommand::hidden("/subscribe", "Why and how to subscribe to Honey"),
    RegisteredCommand::hidden("/config", "Show or edit configuration"),
    RegisteredCommand::hidden("/log", "Mark the current location in the logs"),
    RegisteredCommand::hidden(
        "/keys",
        "List Desktop keybindings and contexts (/keys refresh to refresh the list)",
    ),
    RegisteredCommand::hidden("/keybindings", "Alias for /keys"),
    RegisteredCommand::hidden(
        "/diff",
        "Cycle or set diff display mode (off/inline/full/pinned/file)",
    ),
    RegisteredCommand::hidden(
        "/onboarding-preview",
        "Open real first-run Desktop in a separate fresh-profile window (Alt+9)",
    ),
    RegisteredCommand::hidden(
        "/onboarding-sim",
        "Open real first-run Desktop with an isolated fresh profile (Alt+9)",
    ),
    RegisteredCommand::public("/reload", "Reload into newest available binary"),
    RegisteredCommand::hidden("/restart", "Restart with current binary"),
    RegisteredCommand::hidden(
        "/restart-all",
        "Restart the server and every Desktop window, restoring all windows and sessions",
    ),
    RegisteredCommand::hidden("/rebuild", "Background rebuild and auto reload"),
    RegisteredCommand::hidden("/selfdev", "Open a new self-dev session"),
    RegisteredCommand::hidden("/update", "Background update and auto reload"),
    RegisteredCommand::public("/resume", "Open session picker"),
    RegisteredCommand::hidden("/sessions", "Alias for /resume"),
    RegisteredCommand::hidden("/session", "Alias for /resume"),
    RegisteredCommand::hidden("/active", "Manage live sessions (working vs ready)"),
    RegisteredCommand::hidden("/catchup", "Open Catch Up picker"),
    RegisteredCommand::hidden("/back", "Return to the previous Catch Up session"),
    RegisteredCommand::hidden("/save", "Bookmark session for easy access"),
    RegisteredCommand::hidden("/unsave", "Remove bookmark from session"),
    RegisteredCommand::hidden("/rename", "Rename current session"),
    RegisteredCommand::public("/fork", "Fork session into a new window (optional prompt)"),
    RegisteredCommand::hidden("/split", "Alias for /fork"),
    RegisteredCommand::hidden("/transfer", "Compact context into a fresh handoff session"),
    RegisteredCommand::hidden("/workspace", "Niri-style session workspace"),
    RegisteredCommand::public("/quit", "Exit Honey"),
    RegisteredCommand::hidden("/auth", "Show authentication status"),
    RegisteredCommand::hidden("/login", "Login to a provider"),
    RegisteredCommand::hidden("/logout", "Log out of a provider"),
    RegisteredCommand::hidden("/account", "Open the combined account picker"),
    RegisteredCommand::hidden("/accounts", "Alias for /account"),
    RegisteredCommand::hidden("/debug-visual", "Toggle visual debug overlay"),
    RegisteredCommand::hidden("/screenshot-mode", "Hide identifying interface metadata"),
    RegisteredCommand::hidden("/screenshot", "Export a private JSON screenshot debug snapshot"),
    RegisteredCommand::hidden("/record", "Record a bounded debug snapshot timeline (JSONL)"),
    RegisteredCommand::hidden("/client-reload", "Rebuild and hot-reload the Desktop UI"),
];

/// Every non-hidden slash command with its one-line description, in
/// registration order. The `/help` overlay uses this to list commands its
/// hand-written sections have not covered, so a newly registered command can
/// never be invisible to users.
pub(crate) fn registered_command_entries() -> impl Iterator<Item = (&'static str, &'static str)> {
    REGISTERED_COMMANDS
        .iter()
        .filter(|command| !command.hidden)
        .map(|command| (command.name, command.help))
}

pub(crate) fn registered_command(name: &str) -> Option<RegisteredCommand> {
    REGISTERED_COMMANDS
        .iter()
        .copied()
        .find(|command| command.name == name)
}

pub(crate) fn help_markdown() -> String {
    let mut help = String::from("**Commands**\n\n");
    for (name, description) in registered_command_entries() {
        help.push_str(&format!("- `{name}` — {description}\n"));
    }
    help
}

/// Commands that open the session browser instead of reaching the runtime.
pub(crate) fn is_resume_command(content: &str) -> bool {
    matches!(content.trim(), "/resume" | "/sessions" | "/session")
}

/// Both account aliases open Desktop's native picker, not a runtime prompt.
pub(crate) fn is_accounts_command(content: &str) -> bool {
    matches!(content.trim(), "/account" | "/accounts")
}

/// Target of a `/reset` command typed in the composer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResetCommand {
    /// Bare `/reset`: the provider of the panel's current session.
    Current,
    OpenAi,
    Claude,
}

/// Parse `/reset`, `/reset <provider>` and the TUI spelling
/// `/reset usage limits <provider>`. Desktop always opens the read-only
/// review dialog, so the TUI's `confirm` and `cancel` suffixes are accepted
/// and only ever open that review. Nothing is spent without the dialog's button.
pub(crate) fn reset_command(content: &str) -> Option<ResetCommand> {
    let words: Vec<&str> = content.split_whitespace().collect();
    let rest = match words.as_slice() {
        ["/reset", "usage", "limits", rest @ ..] if !rest.is_empty() => rest,
        ["/reset", "usage", ..] => return None,
        ["/reset", rest @ ..] => rest,
        _ => return None,
    };
    let (provider, suffix) = match rest {
        [] => return Some(ResetCommand::Current),
        [provider] => (*provider, None),
        [provider, suffix] => (*provider, Some(*suffix)),
        _ => return None,
    };
    if !matches!(suffix, None | Some("confirm" | "cancel")) {
        return None;
    }
    match provider.to_ascii_lowercase().as_str() {
        "openai" | "codex" | "chatgpt" => Some(ResetCommand::OpenAi),
        "claude" | "anthropic" => Some(ResetCommand::Claude),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reset_command_accepts_desktop_and_tui_spellings() {
        assert_eq!(reset_command("/reset"), Some(ResetCommand::Current));
        assert_eq!(reset_command(" /reset claude "), Some(ResetCommand::Claude));
        assert_eq!(reset_command("/reset Anthropic"), Some(ResetCommand::Claude));
        assert_eq!(
            reset_command("/reset usage limits claude"),
            Some(ResetCommand::Claude)
        );
        assert_eq!(
            reset_command("/reset usage limits claude confirm"),
            Some(ResetCommand::Claude)
        );
        assert_eq!(
            reset_command("/reset usage limits openai"),
            Some(ResetCommand::OpenAi)
        );
        assert_eq!(reset_command("/reset codex"), Some(ResetCommand::OpenAi));
        for other in [
            "/resetting",
            "/reset gemini",
            "/reset claude now",
            "/reset usage limits",
            "/reset usage",
            "reset claude",
        ] {
            assert_eq!(reset_command(other), None, "{other}");
        }
        assert!(registered_command("/reset").is_some());
    }

    #[test]
    fn account_aliases_match_complete_commands_only() {
        for command in ["/account", "/accounts", "  /accounts\n", "\t/account "] {
            assert!(is_accounts_command(command));
            assert!(registered_command(command.trim()).is_some());
        }
        for command in ["/accounting", "/accounts-extra", "/account foo", "account"] {
            assert!(!is_accounts_command(command));
        }
    }

    #[test]
    fn desktop_catalog_covers_the_freecode_tui_surface() {
        assert!(REGISTERED_COMMANDS.len() >= 80);
        // Freecode TUI commands with a Desktop equivalent today. `/web`,
        // `/mcp`, `/settings`, `/shells`, `/tree`, `/extensions`, `/cost` and
        // `/graph` exist in the TUI but have no Desktop panel yet — tracked
        // as follow-up, not asserted here until they are built.
        for command in [
            "/help", "/model", "/agents", "/night", "/effort", "/resume", "/compact", "/rewind",
            "/fork", "/reload", "/context", "/usage", "/skills",
        ] {
            assert!(registered_command(command).is_some(), "missing {command}");
        }
    }

    /// The `/` picker and `/help` must show exactly freecode's own TUI
    /// surface, no more — a command Desktop can still run when typed
    /// directly (session save/rename, theming, git/release tooling, the
    /// account picker, …) is `hidden` rather than deleted, which keeps it
    /// working without making it look like a freecode feature. `/quit` is
    /// the one deliberate exception: every app needs a visible way to quit,
    /// even though freecode's TUI spells its equivalent `/exit`.
    #[test]
    fn picker_shows_only_the_freecode_tui_surface_plus_quit() {
        let visible: std::collections::BTreeSet<&str> =
            registered_command_entries().map(|(name, _)| name).collect();
        let expected: std::collections::BTreeSet<&str> = [
            "/help", "/model", "/agents", "/night", "/effort", "/resume", "/compact", "/rewind",
            "/fork", "/reload", "/context", "/usage", "/skills", "/clear", "/quit",
        ]
        .into_iter()
        .collect();
        assert_eq!(visible, expected);
        // Spot-check a few Desktop-only extras: still registered (so typing
        // them still works) but not in the picker.
        for command in [
            "/auth", "/login", "/logout", "/account", "/memory", "/info", "/commit", "/rename",
            "/colors", "/git", "/save", "/selfdev", "/publish", "/triage",
        ] {
            let entry = registered_command(command).unwrap_or_else(|| panic!("missing {command}"));
            assert!(entry.hidden, "{command} should be hidden, not deleted");
        }
    }

    /// Commands with no freecode equivalent at all (jcode's own monetization,
    /// swarm routing, GitHub triage automation, a separate review/judge
    /// session, …) are not registered, not just hidden — see
    /// `jcode-sdk/src/client.rs`'s `runtime_command` for the full reasoning.
    #[test]
    fn commands_with_no_freecode_equivalent_are_not_registered() {
        for command in [
            "/provider-test-coverage",
            "/model-status",
            "/refresh-model-list",
            "/subagent",
            "/subagent-model",
            "/autoreview",
            "/autojudge",
            "/review",
            "/judge",
            "/fast",
            "/transport",
            "/initiatives",
            "/goals",
            "/swarm",
            "/overnight",
            "/productivity",
            "/wrapped",
            "/feedback",
            "/telemetry",
            "/subscription",
            "/cache",
            "/remote",
            "/server-reload",
            "/continue",
            "/resumeall",
            "/resume-all",
            "/z",
            "/zz",
            "/zzz",
            "/zstatus",
        ] {
            assert!(registered_command(command).is_none(), "{command} should be gone");
        }
        assert!(!registered_command_entries().any(|(name, _)| name == "/zzz"));
    }
}
