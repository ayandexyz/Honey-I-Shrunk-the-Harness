import type { CommandModule } from "yargs";
// Type-only: erased at compile time, so it costs the --help path nothing and
// keeps the flag's choices tied to the shared union rather than a local copy.
import type { EffortLevel } from "@thisisayande/freecode-shared";

// Headless single-turn run: `freecode run [message..]`.
// Boots the same backend the JSON-RPC server uses (providers, MCP, Effect
// runtime), drives one agent turn, streams assistant text to stdout and tool
// activity to stderr, then exits. No TUI, no stdin JSON-RPC — designed for
// scripting and piping (`freecode run "..." | cat`).

interface RunArgs {
  message: string[];
  model?: string;
  effort?: EffortLevel;
  agent: string;
  continue: boolean;
  session?: string;
  maxTurns?: number;
  yes: boolean;
  allow: string[];
}

type AgentMode = "plan" | "build" | "review" | "explore" | "danger";

// Passed to yargs `choices`, which rejects anything else at parse time. That
// runtime check is what makes the cast at the read site safe: `--agent buld`
// now exits with a usage error instead of silently running as `build`.
const AGENT_MODES: AgentMode[] = [
  "plan",
  "build",
  "review",
  "explore",
  "danger",
];

// Same `choices` guarantee as AGENT_MODES: yargs rejects anything else at
// parse time, which is what makes the cast at the read site safe.
//
// Omitting --effort leaves `effort` undefined, and undefined is NOT the same
// as "low": applyEffort() returns early on undefined, so the provider's own
// default applies. That distinction is the whole point of this flag — the TUI
// sends an explicit level on every turn, so without a way to say the same
// thing here, a headless run could not reproduce a TUI turn.
const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

// Read piped stdin when no message positional was given (e.g. `echo ... | freecode run`).
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

export const runCommand: CommandModule<object, RunArgs> = {
  command: "run [message..]",
  describe: "Run freecode headlessly with a single message",
  builder: (yargs) =>
    yargs
      .positional("message", {
        type: "string",
        array: true,
        default: [],
        describe: "the message to send",
      })
      .option("model", {
        alias: "m",
        type: "string",
        describe: "model to use, in provider/model format",
      })
      .option("effort", {
        type: "string",
        choices: EFFORT_LEVELS,
        describe:
          "reasoning effort; omitted leaves the provider default (only anthropic/openai/gemini honour it)",
      })
      .option("agent", {
        type: "string",
        default: "build",
        choices: AGENT_MODES,
        describe: "agent mode",
      })
      .option("continue", {
        alias: "c",
        type: "boolean",
        default: false,
        describe: "continue the last session in this project",
      })
      .option("session", {
        alias: "s",
        type: "string",
        describe: "session id to continue",
      })
      .option("max-turns", {
        type: "number",
        describe:
          "cap on agent iterations; unbounded (loop-health + gates only) if omitted",
      })
      .option("yes", {
        alias: "y",
        type: "boolean",
        default: false,
        describe:
          "approve permission prompts automatically; deny rules and read-only modes still refuse",
      })
      .option("allow", {
        type: "string",
        array: true,
        default: [] as string[],
        describe:
          "grant a permission rule for this run only, e.g. --allow 'Bash(npm test:*)' (repeatable)",
      }),
  handler: async (argv) => {
    // Lazy imports: `run` pulls in the full backend, which no other command
    // (or the --help path) should pay for.
    const { initProviders } = await import("../../providers/index.js");
    const { initMcpServers, stopMcpServers } = await import(
      "../../mcp/index.js"
    );
    const { readConfig, fallbackProviderFromCredentials } = await import(
      "../../providers/config.js"
    );
    const { getAppRuntime } = await import("../../effect/runtime.js");
    const { createAgentLoopEffect } = await import("../../agent/loop.js");
    const { getSessionManager } = await import("../../session/index.js");
    const { bus } = await import("../../bus/index.js");
    const { initHooks } = await import("../../hooks/bootstrap.js");
    const { endSession } = await import("../../session/end-session.js");
    const { sessionMemoryFlush } = await import(
      "../../session/session-flush.js"
    );
    const { SessionStoreTag } = await import("../../effect/context.js");
    const { disposeAllShellRegistries } = await import(
      "../../tools/shells/index.js"
    );
    const { disposeAllAgents } = await import(
      "../../agent/registry/index.js"
    );
    const { disposeAll: disposeLspServers } = await import(
      "../../tools/lsp/client.js"
    );

    let prompt = argv.message.join(" ").trim();
    if (!prompt && !process.stdin.isTTY) {
      prompt = await readStdin();
    }
    if (!prompt) {
      console.error("Error: no message provided");
      process.exitCode = 1;
      return;
    }

    const projectPath = process.cwd();
    let provider: string | undefined;
    let sessionId: string | undefined;
    let unsubscribe = () => {};
    let disposeHooks = () => {};
    let exitCode = 1;
    try {
      await initProviders();
      await initMcpServers();
      const { loadExtensions } = await import("../../extensions/index.js");
      await loadExtensions(projectPath);
      // Same hooks a served session gets. Not watched: this process runs one
      // turn and exits, so a settings edit mid-run cannot take effect anyway.
      const hookSettings = initHooks(projectPath, { watch: false });
      disposeHooks = () => hookSettings.dispose();

      const config = readConfig();
      // --model provider/model overrides the configured current model.
      provider = config.current?.provider;
      let model = config.current?.model;
      if (argv.model) {
        const slash = argv.model.indexOf("/");
        if (slash > 0) {
          provider = argv.model.slice(0, slash);
          model = argv.model.slice(slash + 1);
        } else {
          model = argv.model;
        }
      }

      if (!provider) {
        // A sole configured credential (e.g. only ANTHROPIC_API_KEY exported)
        // selects the provider; several throw naming them.
        provider = fallbackProviderFromCredentials();
      }
      if (!provider) {
        throw new Error(
          "No provider configured. Set current.provider in ~/.freecode/config.json, " +
            "export a provider API key (e.g. ANTHROPIC_API_KEY), " +
            "or pass --model <provider>/<model>.",
        );
      }

      const manager = await getSessionManager();
      // Resolve the session: explicit id > continue last > fresh.
      if (argv.session) {
        sessionId = (await manager.resume(argv.session)).id;
      } else if (argv.continue) {
        const [latest] = await manager.list({ projectPath, status: "active" });
        sessionId = latest
          ? (await manager.resume(latest.id)).id
          : await manager.start(projectPath, provider);
      } else {
        sessionId = await manager.start(projectPath, provider);
      }

      // Stream relay → console. Assistant text goes to stdout (pipeable); tool
      // activity and thinking go to stderr so they never pollute the payload.
      unsubscribe = bus.subscribe("stream", (e) => {
        if (e.sessionId !== sessionId) return;
        const ev = e.event;
        switch (ev.type) {
          case "text_delta":
            process.stdout.write(ev.delta);
            break;
          case "tool_start":
            process.stderr.write(`\n\x1b[2m• ${ev.toolName}\x1b[0m\n`);
            break;
          case "error":
            process.stderr.write(`\n\x1b[31m${ev.content}\x1b[0m\n`);
            break;
        }
      });

      // Safe: yargs `choices` rejected anything outside AGENT_MODES already.
      const agentMode = argv.agent as AgentMode;
      const loop = await getAppRuntime().runPromise(
        // Unbounded unless --max-turns is passed, matching Claude Code's
        // headless mode (maxTurns is opt-in there too, not a default cap).
        createAgentLoopEffect(sessionId, {
          ...(argv.maxTurns ? { maxIterations: argv.maxTurns } : {}),
          // Without one of these, `build` denies every mutating tool here:
          // there is no frontend to answer an `ask`, and an unanswered ask is
          // a denial by design (permission/prompt.ts).
          autoApproveAsks: argv.yes,
          sessionGrants: argv.allow,
        }),
      );
      const result = await getAppRuntime().runPromise(
        loop.runEffect({
          prompt,
          sessionId,
          provider,
          model,
          projectPath,
          agentMode,
          // Safe: yargs `choices` rejected anything outside EFFORT_LEVELS.
          effort: argv.effort as EffortLevel | undefined,
        }),
      );
      process.stdout.write("\n");
      exitCode = result.success ? 0 : 1;
    } catch (err) {
      console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
      exitCode = 1;
    } finally {
      unsubscribe();
      if (sessionId && provider) {
        const drain = await endSession(sessionId, {
          reason: "exit",
          flush: sessionMemoryFlush({
            sessionId,
            projectPath,
            provider,
            getStore: () => getAppRuntime().runPromise(SessionStoreTag),
          }),
        });
        if (drain.memoryDrainTimedOut || drain.pendingMemoryJobs > 0) {
          process.stderr.write(
            `[freecode] memory shutdown timed out with ${drain.pendingMemoryJobs} job(s) still pending\n`,
          );
        }
      }

      // Process-owned resources are not scoped to endSession. Tear each down
      // before selecting the exit code so a child cannot keep a headless run
      // alive after its answer has already been printed.
      const dispose = (name: string, fn: () => void) => {
        try {
          fn();
        } catch (error) {
          process.stderr.write(
            `[freecode] ${name} shutdown failed: ${String(error)}\n`,
          );
        }
      };
      dispose("hook", disposeHooks);
      await stopMcpServers().catch((error: unknown) => {
        process.stderr.write(`[freecode] MCP shutdown failed: ${String(error)}\n`);
      });
      dispose("shell", disposeAllShellRegistries);
      dispose("agent", disposeAllAgents);
      dispose("language-server", disposeLspServers);
      process.exitCode = exitCode;
    }
  },
};
