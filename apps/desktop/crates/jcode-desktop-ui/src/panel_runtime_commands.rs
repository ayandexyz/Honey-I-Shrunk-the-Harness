//! Runtime slash commands execute on the selected session's own connection.
use super::*;
use jcode_sdk::api::RuntimeCommand;

/// Only the variants `jcode-sdk`'s `runtime_command()` actually dispatches
/// to a freecode IPC call. Everything else jcode's own TUI had here (swarm,
/// review/judge-as-separate-sessions, subagent-model, autoreview/autojudge,
/// transport, fast, telemetry, subscription, provider-test-coverage,
/// refresh-model-list, continue, resumeall, …) has no freecode backend to
/// reach and is not parsed — see `commands.rs`'s
/// `commands_with_no_freecode_equivalent_are_not_registered` test.
fn parse_runtime_command(content: &str) -> Option<(RuntimeCommand, Vec<String>)> {
    let mut words = content.split_whitespace();
    let command = match words.next()? {
        "/auth" => RuntimeCommand::Auth,
        "/logout" => RuntimeCommand::Logout,
        "/skills" => RuntimeCommand::Skills,
        "/context" => RuntimeCommand::Context,
        "/info" => RuntimeCommand::Info,
        "/memory" => RuntimeCommand::Memory,
        "/agents" => RuntimeCommand::Agents,
        _ => return None,
    };
    Some((command, words.map(str::to_owned).collect()))
}

impl Panel {
    pub(super) fn handle_runtime_command(&mut self, content: &str, cx: &mut Context<Self>) -> bool {
        let Some((command, args)) = parse_runtime_command(content) else {
            return false;
        };
        if self.is_side_document() || self.preview_state.is_some() {
            self.items.push(Item::Error(
                "Runtime commands require a live session.".into(),
            ));
        } else {
            self.bridge.send(Command::RuntimeCommand {
                session_id: self.session_id.clone(),
                command,
                args,
            });
        }
        cx.notify();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_all_runtime_commands_exactly() {
        for name in ["auth", "logout", "skills", "context", "info", "memory", "agents"] {
            assert!(
                parse_runtime_command(&format!("/{name}")).is_some(),
                "{name}"
            );
            assert!(
                parse_runtime_command(&format!("/{name}-extra")).is_none(),
                "{name}"
            );
        }
        for content in [
            "skills",
            "/Skills",
            "/skill",
            "/help",
            "",
            "/memoryish",
            // Cut: jcode-only, no freecode backend to reach.
            "/swarm",
            "/review",
            "/judge",
            "/subagent",
            "/subagent-model",
            "/autoreview",
            "/autojudge",
            "/transport",
            "/fast",
            "/telemetry",
            "/subscription",
            "/cache",
            "/provider-test-coverage",
            "/model-status",
            "/refresh-model-list",
            "/continue",
            "/resumeall",
        ] {
            assert!(parse_runtime_command(content).is_none(), "{content}");
        }
    }

    #[test]
    fn preserves_arguments_without_local_interpretation() {
        let (command, args) = parse_runtime_command("  /memory   on  extra  ").unwrap();
        assert_eq!(command, RuntimeCommand::Memory);
        assert_eq!(args, vec!["on", "extra"]);
        let (command, args) = parse_runtime_command("/logout anthropic").unwrap();
        assert_eq!(command, RuntimeCommand::Logout);
        assert_eq!(args, vec!["anthropic"]);
        assert_eq!(
            parse_runtime_command("/info").unwrap().1,
            Vec::<String>::new()
        );
    }
}
