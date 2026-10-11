/**
 * The `/` menu's content, shaped like the Omarchy menu: a root of categories
 * that drill down into commands, plus a search across every command. Pure
 * data — the card that draws it is `menu-card.ts`.
 *
 * Commands are grouped here by name rather than carrying a group field, so a
 * prompt command from core (skills, extensions, user commands) needs no
 * protocol change: anything not listed lands under "Prompts".
 */

import type { MenuRow, MenuSource } from "./menu-card.js";

export interface MenuCommand {
  name: string;
  description: string;
  argHint?: string;
}

/** A group row opens its id; a leaf carries the command it runs. */
export interface SlashRow extends MenuRow {
  command?: MenuCommand;
}

interface Group {
  id: string;
  label: string;
  icon: string;
  commands: string[];
}

// Glyphs are Nerd Font code points the Omarchy menu itself renders, so they
// are known to exist in the fonts Omarchy ships.
const GROUPS: Group[] = [
  { id: "model", label: "Model", icon: "\u{f06a9}", commands: ["model", "web", "effort"] },
  {
    id: "session",
    label: "Session",
    icon: "\u{f46a}",
    commands: ["resume", "tree", "rewind", "fork", "compact", "clear"],
  },
  { id: "inspect", label: "Inspect", icon: "\u{ea74}", commands: ["context", "cost", "usage", "graph"] },
  { id: "running", label: "Running", icon: "\u{f489}", commands: ["shells", "agents"] },
  { id: "extend", label: "Extend", icon: "\u{f0431}", commands: ["mcp", "skills", "extensions", "reload"] },
];

const PROMPTS: Omit<Group, "commands"> = { id: "prompts", label: "Prompts", icon: "\u{f044}" };

/** Commands that sit on the root itself, after the groups — Omarchy's About/System. */
const ROOT_LEAVES: Record<string, string> = {
  settings: "\u{f0493}", // md-cog
  help: "\u{f11c}",
  exit: "\u{f0343}",
};

const LEAF_ICONS: Record<string, string> = {
  model: "\u{f06a9}",
  web: "\u{f059f}",
  effort: "\u{f04c5}",
  resume: "\u{f46a}",
  tree: "\u{f062c}", // md-source_branch
  rewind: "\u{f0453}",
  fork: "\u{f018f}",
  compact: "\u{f084d}", // md-arrow_collapse_vertical
  clear: "\u{f0b4c}",
  context: "\u{ea74}",
  cost: "\u{f01c1}", // md-currency_usd
  graph: "\u{f1049}", // md-graph
  usage: "\u{f02ca}",
  shells: "\u{f489}",
  agents: "\u{f06a9}",
  mcp: "\u{f0431}",
  skills: "\u{f16a4}",
  extensions: "\u{f0431}",
  reload: "\u{f021}",
  ...ROOT_LEAVES,
};

/** Any command without its own glyph — prompt commands from core. md-message_text. */
const DEFAULT_LEAF_ICON = "\u{f0369}";

const GROUPED = new Set(GROUPS.flatMap((g) => g.commands));

function leaf(command: MenuCommand): SlashRow {
  return {
    id: command.name,
    label: command.argHint ? `${command.name} ${command.argHint}` : command.name,
    icon: LEAF_ICONS[command.name] ?? DEFAULT_LEAF_ICON,
    description: command.description,
    command,
  };
}

export class SlashMenuModel implements MenuSource<SlashRow> {
  private readonly byName: Map<string, MenuCommand>;

  constructor(private readonly commands: MenuCommand[]) {
    this.byName = new Map(commands.map((c) => [c.name, c]));
  }

  private groupCommands(id: string): MenuCommand[] {
    if (id === PROMPTS.id) {
      return this.commands.filter(
        (c) => !GROUPED.has(c.name) && !(c.name in ROOT_LEAVES),
      );
    }
    const group = GROUPS.find((g) => g.id === id);
    return (group?.commands ?? []).flatMap((name) => {
      const c = this.byName.get(name);
      return c ? [c] : [];
    });
  }

  /** Header text for a submenu — `null` is the root. */
  title(groupId: string | null): string {
    if (groupId === null) return "Go";
    return [...GROUPS, PROMPTS].find((g) => g.id === groupId)?.label ?? groupId;
  }

  /** Rows of the root (`null`) or of one group. Empty groups are hidden. */
  rows(groupId: string | null): SlashRow[] {
    if (groupId !== null) return this.groupCommands(groupId).map(leaf);
    const groups = [...GROUPS, PROMPTS]
      .filter((g) => this.groupCommands(g.id).length > 0)
      .map((g) => ({ id: g.id, label: g.label, icon: g.icon, opens: true }));
    const leaves = Object.keys(ROOT_LEAVES).flatMap((name) => {
      const c = this.byName.get(name);
      return c ? [leaf(c)] : [];
    });
    return [...groups, ...leaves];
  }

  /**
   * Every command matching `query`, best first: a name that starts with the
   * query, then one that contains it, then a description word that starts with
   * it. Groups are never results — search is a list of things you can run.
   */
  search(query: string): SlashRow[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const score = (c: MenuCommand): number => {
      const name = c.name.toLowerCase();
      if (name.startsWith(q)) return 0;
      if (name.includes(q)) return 1;
      if (c.description.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.startsWith(q))) return 2;
      return -1;
    };
    return this.commands
      .map((c) => ({ c, s: score(c) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => a.s - b.s || a.c.name.localeCompare(b.c.name))
      .map((r) => leaf(r.c));
  }
}
