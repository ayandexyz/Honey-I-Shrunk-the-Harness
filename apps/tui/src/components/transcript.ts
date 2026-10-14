import type { TUI } from "@earendil-works/pi-tui";
import type { StreamEvent } from "@thisisayande/freecode-shared";
import type { MessageStore } from "../state/message-store.js";
import {
  createMessageComponent,
  ThinkingMessage,
  StreamingAssistantMessage,
} from "./message-row.js";
import type { MessageInstance } from "./message-types.js";
import { ToolProgressMessage } from "./tool-progress-message.js";
import { ToolResultMessage, FILE_UPDATE_TOOLS } from "./tool-result-message.js";
import { ToolGroupMessage } from "./tool-group-message.js";

/** The stream events a transcript renders; everything else is a side channel. */
const TRANSCRIPT_EVENTS = new Set<StreamEvent["type"]>([
  "tool_start",
  "tool_output",
  "tool_complete",
  "thinking",
  "thinking_delta",
  "text",
  "text_delta",
]);

/**
 * Transcript — turns an agent's stream events into rows of ONE message store.
 *
 * The main conversation and every watched subagent are each a Transcript
 * over their own store, so a subagent renders through the same tool cards,
 * thinking blocks and streaming rows as the main agent, with none of its
 * state (the live assistant row, the open tool group, the reasoning timer)
 * leaking into another transcript's.
 */
export class Transcript {
  // The assistant row currently streaming in, if any. One per internal turn:
  // the turn-end `text` snapshot settles it, and the next turn's first delta
  // starts a fresh row. If a tool call follows, that row is a tool preamble
  // and moves into the tool group; otherwise it remains the full final reply.
  private liveAssistant: {
    instance: MessageInstance;
    component: StreamingAssistantMessage;
  } | null = null;
  private thinkingStartTime: number | null = null;
  private toolProgress = new Map<
    string,
    {
      progress: ToolProgressMessage;
      message: MessageInstance;
      args: Record<string, unknown>;
      narration?: string;
    }
  >();

  constructor(
    readonly store: MessageStore,
    private tui: TUI | null = null,
  ) {}

  setTui(tui: TUI): void {
    this.tui = tui;
  }

  /** Forget in-flight state; call alongside clearing the store. */
  reset(): void {
    this.liveAssistant = null;
    this.thinkingStartTime = null;
    this.toolProgress.clear();
  }

  static handles(type: StreamEvent["type"]): boolean {
    return TRANSCRIPT_EVENTS.has(type);
  }

  /** Args recorded at `tool_start`, for callers that need them at completion. */
  toolArgs(toolCallId: string): Record<string, unknown> | undefined {
    return this.toolProgress.get(toolCallId)?.args;
  }

  /** Render one stream event. Returns false for events this class ignores. */
  apply(event: StreamEvent): boolean {
    if (!Transcript.handles(event.type)) return false;

    const isThinking =
      event.type === "thinking" || event.type === "thinking_delta";
    if (isThinking) {
      if (this.thinkingStartTime === null) this.thinkingStartTime = Date.now();
    } else {
      // First non-thinking event ends the current reasoning block: freeze its
      // elapsed timer so the header collapses to "Thought (Ns)".
      const messages = this.store.getMessages();
      const last = messages[messages.length - 1];
      if (last?.component instanceof ThinkingMessage && !last.component.done) {
        last.component.setDone();
        this.thinkingStartTime = null;
      }
    }

    switch (event.type) {
      case "tool_start": {
        const { message, progress, narration } = this.createToolProgressMessage(
          event.toolCallId,
          event.toolName,
          event.args,
        );
        if (this.tui) progress.setTui(this.tui);
        this.toolProgress.set(event.toolCallId, {
          progress,
          message,
          args: event.args,
          narration,
        });
        break;
      }
      case "tool_output": {
        const entry = this.toolProgress.get(event.toolCallId);
        if (entry) {
          // Only the last 5 lines are ever shown, so don't split a large
          // output in full — a 4KB tail is more than 5 terminal rows.
          const tail =
            event.content.length > 4096
              ? event.content.slice(-4096)
              : event.content;
          entry.progress.updateOutput(tail.split("\n").slice(-5));
        }
        break;
      }
      case "tool_complete": {
        const entry = this.toolProgress.get(event.toolCallId);
        if (entry) {
          this.removeToolProgressMessage(entry.message, entry.progress);
          this.toolProgress.delete(event.toolCallId);
        }
        this.createToolResultMessage(
          event.toolCallId,
          event.toolName,
          entry?.args ?? {},
          event.result,
          event.success,
          event.duration_ms,
          entry?.narration,
        );
        break;
      }
      case "thinking":
        // Turn-end reasoning snapshot — authoritative, replaces whatever the
        // thinking_delta stream accumulated (it wins over any dropped chunk).
        this.createThinkingMessage(
          event.content,
          this.thinkingStartTime || Date.now(),
        );
        break;
      case "thinking_delta":
        this.appendThinkingDelta(
          event.delta,
          this.thinkingStartTime || Date.now(),
        );
        break;
      case "text_delta":
        this.appendAssistantDelta(event.delta);
        break;
      case "text":
        // Authoritative per-internal-turn snapshot: settles the live streaming
        // row, or on the non-streaming provider path is itself the render.
        this.finalizeAssistantText(event.content);
        break;
    }
    this.tui?.requestRender();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Row builders — the same ones the main conversation has always used.
  // ---------------------------------------------------------------------------

  createAssistantMessage(content: string): MessageInstance {
    this.sealToolGroups();
    const component = createMessageComponent("assistant", content);
    return this.store.add("assistant", content, component);
  }

  /**
   * Append a streamed `text_delta` chunk, creating the live assistant row on
   * the first delta of an internal turn.
   */
  appendAssistantDelta(delta: string): MessageInstance {
    if (this.liveAssistant && !this.liveAssistant.component.done) {
      this.liveAssistant.component.append(delta);
      return this.liveAssistant.instance;
    }
    const component = new StreamingAssistantMessage(delta);
    const instance = this.store.add("assistant", delta, component);
    this.liveAssistant = { instance, component };
    return instance;
  }

  /**
   * Settle the live streaming row with the turn's authoritative `text`
   * snapshot. With no live row and a snapshot in hand (the non-streaming
   * provider path emits no deltas), the snapshot renders as a settled
   * assistant message. Without either, this is a no-op — it doubles as the
   * "close any dangling stream" call on the abort/error paths.
   */
  finalizeAssistantText(content?: string): MessageInstance | null {
    if (this.liveAssistant) {
      const { instance, component } = this.liveAssistant;
      this.liveAssistant = null;
      component.finalize(content);
      // Same component, refreshed content — keeps message.content truthful for
      // anything reading the store, and the notify re-renders the row settled.
      return (
        this.store.update(instance.id, component.content, component) ?? instance
      );
    }
    if (content) {
      // This may still prove to be a preamble when the next event is a tool
      // call, so do not seal the preceding tool group yet.
      const display = `**FreeCode:** ${content}`;
      const component = createMessageComponent("assistant", display);
      return this.store.add("assistant", display, component);
    }
    return null;
  }

  /**
   * Append a streamed `thinking_delta` chunk into the open thinking block,
   * creating it on the first chunk. The turn-end `thinking` snapshot still
   * flows through createThinkingMessage, which replaces the whole buffer.
   */
  appendThinkingDelta(delta: string, startTime?: number): MessageInstance {
    const messages = this.store.getMessages();
    const last = messages[messages.length - 1];
    if (last && last.component instanceof ThinkingMessage && !last.component.done) {
      last.component.appendContent(delta);
      return last;
    }
    this.sealToolGroups();
    const component = new ThinkingMessage(delta, startTime);
    return this.store.add("thinking", delta, component);
  }

  /** Create or update a thinking message — the LLM's reasoning block. */
  createThinkingMessage(content: string, startTime?: number): MessageInstance {
    const messages = this.store.getMessages();
    const last = messages[messages.length - 1];
    // Update the streaming thinking block in place, preserving its startTime.
    if (last && last.component instanceof ThinkingMessage) {
      last.component.updateContent(content);
      return last;
    }
    this.sealToolGroups();
    const component = createMessageComponent("thinking", content, startTime);
    return this.store.add("thinking", content, component);
  }

  /**
   * A running tool call. Calls that will fold into a group when they finish
   * are drawn inside that group from the start (see ToolGroupMessage), so the
   * row does not flash standalone and then jump into the summary. File updates
   * stand alone either way, so their progress row does too.
   */
  createToolProgressMessage(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): {
    message: MessageInstance;
    progress: ToolProgressMessage;
    narration?: string;
  } {
    const progress = new ToolProgressMessage({
      toolCallId,
      toolName,
      args,
      outputLines: [],
    });
    const narration = this.takeAdjacentAssistantNarration();
    if (FILE_UPDATE_TOOLS.has(toolName.toLowerCase())) {
      return {
        message: this.store.add("tool", toolName, progress),
        progress,
        narration,
      };
    }
    let group = this.findOpenToolGroup();
    let message =
      group && this.store.getMessages().find((m) => m.component === group);
    if (!group || !message) {
      group = new ToolGroupMessage(this.lastMessageIsPrompt());
      message = this.store.add("tool", toolName, group);
    }
    if (narration) group.addNarration(narration);
    group.addPending(progress);
    // Same store entry, new content — notifies the list like a result does.
    this.store.update(message.id, toolName, group);
    return { message, progress, narration };
  }

  /** Undoes createToolProgressMessage once the call's result arrives. */
  removeToolProgressMessage(
    message: MessageInstance,
    progress: ToolProgressMessage,
  ): void {
    progress.invalidate();
    if (message.component instanceof ToolGroupMessage) {
      message.component.removePending(progress);
    } else {
      this.store.remove(message.id);
    }
  }

  /**
   * Closes every open tool group. A user prompt, an assistant reply, or a
   * thinking block ends the run of calls it belongs to, so the next call
   * starts a fresh group below the new message.
   */
  sealToolGroups(): void {
    for (const msg of this.store.getMessages()) {
      if (msg.component instanceof ToolGroupMessage) msg.component.seal();
    }
  }

  /**
   * The group still accepting calls, if any. Tool progress rows and the
   * in-progress line are skipped: with parallel tools, a sibling that is
   * still running sits between the group and the result now arriving, and
   * that must not start a second group.
   */
  private findOpenToolGroup(): ToolGroupMessage | undefined {
    const messages = this.store.getMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      if (msg.component instanceof ToolGroupMessage) {
        return msg.component.isSealed ? undefined : msg.component;
      }
      if (msg.component instanceof ToolProgressMessage) continue;
      if (msg.type === "in_progress") continue;
      // Ambient notices (cache status, recovery lines) interleave with tool
      // calls but are not part of the conversation, so they must not chop one
      // run of calls into a group per call.
      if (msg.type === "system") continue;
      return undefined;
    }
    return undefined;
  }

  /**
   * A settled assistant row immediately followed by a tool call is
   * operational narration, not a user-facing answer. Remove the standalone
   * row and return its text so the tool group can render it compactly.
   */
  private takeAdjacentAssistantNarration(): string | undefined {
    const messages = this.store.getMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]!;
      if (message.type === "in_progress" || message.type === "system") continue;
      if (message.type !== "assistant") return undefined;

      let content = message.content;
      if (this.liveAssistant?.instance.id === message.id) {
        // The store's content is only the first delta (never updated by
        // later appends), so read the component's accumulated text instead.
        content = this.liveAssistant.component.content;
        this.liveAssistant.component.finalize();
        this.liveAssistant = null;
      }
      this.store.remove(message.id);
      return content;
    }
    return undefined;
  }

  createToolResultMessage(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    result: string | undefined,
    success: boolean,
    duration_ms?: number,
    narration?: string,
  ): MessageInstance {
    const options = {
      toolCallId,
      toolName,
      args,
      result,
      success,
      duration_ms,
      narration,
    };

    // File updates carry the diff view — the one tool body worth showing
    // unprompted. They stand alone instead of folding into a collapsed group,
    // and they seal the current run so the next call starts a fresh group.
    if (FILE_UPDATE_TOOLS.has(toolName.toLowerCase())) {
      this.sealToolGroups();
      return this.store.add("tool", toolName, new ToolResultMessage(options));
    }

    const open = this.findOpenToolGroup();
    if (open) {
      open.add(options);
      // Same store entry, new content — the list re-renders it in place.
      return this.store.update(
        this.store.getMessages().find((m) => m.component === open)!.id,
        toolName,
        open,
      )!;
    }

    const group = new ToolGroupMessage(this.lastMessageIsPrompt());
    group.add(options);
    return this.store.add("tool", toolName, group);
  }

  /**
   * Is the user's prompt the last conversation message? The in-progress row
   * and ambient system notices sit after it in the store without being part
   * of the conversation, so they are skipped like findOpenToolGroup does.
   */
  private lastMessageIsPrompt(): boolean {
    const messages = this.store.getMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const type = messages[i]!.type;
      if (type === "in_progress" || type === "system") continue;
      return type === "user";
    }
    return false;
  }
}
