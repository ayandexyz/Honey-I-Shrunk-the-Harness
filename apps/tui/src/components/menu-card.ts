import {
  Key,
  decodeKittyPrintable,
  fuzzyFilter,
  getKeybindings,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { palette } from "../palette.js";
import { isPrintable } from "./searchable-select-list.js";

export interface MenuRow {
  id: string;
  label: string;
  icon?: string;
  /** Opens the submenu `id` instead of being picked. */
  opens?: boolean;
  /** Dim text after the label, shown only while searching. */
  description?: string;
  /** Right-aligned and always shown, already painted — a provider's status. */
  status?: string;
}

/** What a card lists: a root (`null`) with optional submenus, and a search. */
export interface MenuSource<R extends MenuRow> {
  title(group: string | null): string;
  rows(group: string | null): R[];
  search(query: string): R[];
}

/**
 * A flat list with a fuzzy label/id search (`opus55` finds `claude-opus-5-5`),
 * best match first. Descriptions only substring-match, after those: a
 * subsequence of a long sentence matches nearly anything.
 */
export class ListSource<R extends MenuRow> implements MenuSource<R> {
  constructor(
    private readonly heading: string,
    private readonly items: R[],
  ) {}

  title(): string {
    return this.heading;
  }

  rows(): R[] {
    return this.items;
  }

  search(query: string): R[] {
    const fuzzy = fuzzyFilter(this.items, query, (r) => `${r.label} ${r.id}`);
    const q = query.trim().toLowerCase();
    const seen = new Set(fuzzy);
    const described = this.items.filter(
      (r) => !seen.has(r) && (r.description ?? "").toLowerCase().includes(q),
    );
    return [...fuzzy, ...described];
  }
}

const PAGE = 6;
/** Rows the card costs besides the list: borders, header, and the blank under it. */
const CHROME_ROWS = 4;
const HINT = " ↑↓ move · → open · ← back · esc ";

// eslint-disable-next-line no-control-regex
const stripSgr = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Clip plain text to `width` with an ellipsis. pi-tui's truncateToWidth
 * writes a full reset before its ellipsis, which would end the selection
 * band early, so the codes are stripped — the input carries none.
 */
const fit = (text: string, width: number): string => stripSgr(truncateToWidth(text, width));

/**
 * The Omarchy menu, drawn in the terminal — used by the `/` command menu and
 * the /model and /web pickers. A header that reads `<Title>…` until you type,
 * then shows the query; rows that open a submenu end in `›`; a search
 * flattens the source into one ranked list. Esc clears the query first and
 * closes second, ← / backspace step back out, exactly as the desktop menu
 * does.
 *
 * With `onHandBack` set (the `/` menu), typing past what the menu can match
 * gives the text back to the editor: `/home/me/repo fix this` is a prompt,
 * not a command, so a `/` or a space in the query, or Enter with no match,
 * closes the card and leaves `/<query>` in the composer.
 */
export class MenuCard<R extends MenuRow> implements Component {
  private group: string | null = null;
  private query = "";
  private cursor = 0;
  private scroll = 0;

  /** A row without `opens` was chosen. */
  onPick?: (row: R) => void;
  /** Closed without picking anything. */
  onClose?: () => void;
  /** Back out of the root; defaults to closing. */
  onBack?: () => void;
  /** The query is not a menu search after all — put it in the editor. */
  onHandBack?: (text: string) => void;

  constructor(
    private readonly source: MenuSource<R>,
    private readonly maxRows: () => number,
    private readonly icons: boolean,
  ) {}

  private rows(): R[] {
    return this.query ? this.source.search(this.query) : this.source.rows(this.group);
  }

  private setQuery(query: string): void {
    this.query = query;
    this.cursor = 0;
    this.scroll = 0;
  }

  private open(group: string | null): void {
    this.group = group;
    this.setQuery("");
  }

  private back(): void {
    if (this.group === null) {
      (this.onBack ?? this.onClose)?.();
      return;
    }
    const from = this.group;
    this.open(null);
    this.cursor = Math.max(0, this.rows().findIndex((r) => r.id === from));
  }

  private activate(): void {
    const row = this.rows()[this.cursor];
    if (!row) {
      if (this.query) this.onHandBack?.(`/${this.query}`);
      return;
    }
    if (row.opens) this.open(row.id);
    else this.onPick?.(row);
  }

  private move(delta: number, wrap: boolean): void {
    const n = this.rows().length;
    if (n === 0) return;
    const next = this.cursor + delta;
    this.cursor = wrap ? (next + n) % n : Math.min(n - 1, Math.max(0, next));
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (matchesKey(data, Key.escape)) {
      if (this.query) this.setQuery("");
      else this.onClose?.();
      return;
    }
    if (kb.matches(data, "tui.editor.deleteCharBackward")) {
      if (this.query) this.setQuery(this.query.slice(0, -1));
      else this.back();
      return;
    }
    if (matchesKey(data, Key.left)) {
      if (!this.query) this.back();
      return;
    }
    if (matchesKey(data, Key.right) || kb.matches(data, "tui.select.confirm")) {
      this.activate();
      return;
    }
    if (matchesKey(data, Key.up)) return this.move(-1, true);
    if (matchesKey(data, Key.down)) return this.move(1, true);
    if (matchesKey(data, Key.pageUp)) return this.move(-PAGE, false);
    if (matchesKey(data, Key.pageDown)) return this.move(PAGE, false);

    const kitty = decodeKittyPrintable(data);
    const text = kitty !== undefined ? kitty : isPrintable(data) ? data : undefined;
    if (!text) return;
    if (this.onHandBack && /[\s/]/.test(text)) {
      this.onHandBack(`/${this.query}${text}`);
      return;
    }
    this.setQuery(this.query + text);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const inner = Math.max(20, width - 2);
    const border = palette.accent("│");
    const line = (text: string): string => {
      const clipped = truncateToWidth(text, inner);
      return border + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + border;
    };

    const header = this.query
      ? palette.fgBright(this.query) + palette.accent("▏")
      : palette.muted(`${this.source.title(this.group)}…`);
    const out = [palette.accent("╭" + "─".repeat(inner) + "╮"), line(`  ${header}`), line("")];

    const rows = this.rows();
    const visible = Math.max(1, Math.min(rows.length, this.maxRows() - CHROME_ROWS));
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + visible) this.scroll = this.cursor - visible + 1;
    this.scroll = Math.min(this.scroll, Math.max(0, rows.length - visible));

    if (rows.length === 0) {
      const empty = this.onHandBack ? "No matching command — enter to send as text" : "No match";
      out.push(line(palette.muted(`  ${empty}`)));
    }
    rows.slice(this.scroll, this.scroll + visible).forEach((row, i) => {
      out.push(line(this.renderRow(row, this.scroll + i === this.cursor, inner)));
    });

    const hint = inner >= HINT.length + 2 ? HINT : "";
    out.push(palette.accent("╰─" + hint + "─".repeat(Math.max(0, inner - 1 - hint.length)) + "╯"));
    return out;
  }

  private renderRow(row: R, selected: boolean, inner: number): string {
    const icon = this.icons ? `${row.icon || " "}  ` : "";
    // The selection band is painted over plain text: a pre-painted status
    // would close the selection foreground mid-row.
    const status = row.status ? ` ${selected ? stripSgr(row.status) : row.status}` : "";
    const right = `${status}${row.opens ? " ›" : ""} `;
    // Fit the label here, not in the card's line clip: that clip appends its
    // `…` after the paint has closed, so the ellipsis fell outside the band.
    const left = fit(` ${icon}${row.label}`, Math.max(1, inner - visibleWidth(right)));
    // Descriptions only while searching, as in the desktop menu: browsing is
    // by name, a search result needs to say what it is.
    const detail = this.query && row.description ? `  ${row.description}` : "";
    const room = inner - visibleWidth(left) - visibleWidth(right);
    const desc = room > 3 && detail ? fit(detail, room - 1) : "";
    const gap = " ".repeat(Math.max(0, inner - visibleWidth(left) - visibleWidth(desc) - visibleWidth(right)));
    if (selected) {
      return palette.bgSelection(palette.fgSelection(`${left}${desc}${gap}${right}`));
    }
    return `${left}${palette.muted(desc)}${gap}${palette.muted(right)}`;
  }
}
