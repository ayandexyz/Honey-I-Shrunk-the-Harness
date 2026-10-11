import { SettingsList, type SettingItem, type SettingsListTheme } from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { SettingView } from "@thisisayande/freecode-shared";
import { palette } from "../palette.js";

const theme: SettingsListTheme = {
  label: (text, selected) => (selected ? chalk.bold(palette.accent(text)) : text),
  value: (text, selected) => (selected ? palette.accent(text) : palette.muted(text)),
  description: (text) => palette.muted(text),
  cursor: palette.accent("❯ "),
  hint: (text) => chalk.dim(text),
};

/**
 * One row per setting core reports. A locked row (an env var or the project's
 * settings.json decides it) gets no `values`, so Enter cannot cycle it, and
 * says why in its description.
 */
export function toSettingItems(settings: SettingView[]): SettingItem[] {
  return settings.map((s) => ({
    id: s.key,
    label: s.label,
    description: s.locked ? `${s.description} Locked: ${s.locked}.` : s.description,
    currentValue: s.locked ? `${s.value} (locked)` : s.value,
    values: s.locked ? undefined : s.values,
  }));
}

export function createSettingsPanel(
  settings: SettingView[],
  maxVisible: number,
  onChange: (key: string, value: string) => void,
  onCancel: () => void,
): SettingsList {
  return new SettingsList(toSettingItems(settings), maxVisible, theme, onChange, onCancel, {
    enableSearch: true,
  });
}
