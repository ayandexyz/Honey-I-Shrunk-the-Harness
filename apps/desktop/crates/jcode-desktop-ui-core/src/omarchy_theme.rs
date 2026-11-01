//! Load and parse Omarchy theme from pi.json
//!
//! When running on Omarchy, the desktop app reads the active theme from
//! `~/.local/state/omarchy/current/theme/pi.json` and maps its colors to
//! the desktop Theme struct. The theme is watched for changes and reloaded
//! automatically.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

const OMARCHY_THEME_PATH: &str = "~/.local/state/omarchy/current/theme/pi.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OmarchyThemeFile {
    pub name: String,
    pub vars: HashMap<String, String>,
    pub colors: HashMap<String, String>,
    #[serde(default)]
    pub export: HashMap<String, String>,
}

/// Resolved Omarchy theme colors mapped to desktop semantic names.
#[derive(Debug, Clone)]
pub struct OmarchyTheme {
    pub name: String,
    pub background: String,
    pub foreground: String,
    pub accent: String,
    pub accent_dim: String,
    pub panel_bg: String,
    pub panel_border: String,
    pub panel_border_focus: String,
    pub header_bg: String,
    pub text: String,
    pub text_dim: String,
    pub text_muted: String,
    pub selection_bg: String,
    pub selection_fg: String,
    pub error: String,
    pub error_bg: String,
    pub success: String,
    pub warning: String,
    pub code_bg: String,
    pub code_border: String,
    pub code_keyword: String,
    pub code_string: String,
    pub code_comment: String,
    pub code_number: String,
    pub code_type: String,
    pub code_function: String,
}

impl OmarchyTheme {
    /// Load Omarchy theme from pi.json. Returns None if not on Omarchy or file
    /// doesn't exist.
    pub fn load() -> Option<Self> {
        let path = expand_home(OMARCHY_THEME_PATH)?;
        if !path.exists() {
            return None;
        }

        let content = fs::read_to_string(&path).ok()?;
        let theme_file: OmarchyThemeFile = serde_json::from_str(&content).ok()?;

        Some(Self::from_file(theme_file))
    }

    /// Convert raw theme file to semantic OmarchyTheme.
    fn from_file(file: OmarchyThemeFile) -> Self {
        let vars = &file.vars;
        let get_var = |key: &str| vars.get(key).cloned().unwrap_or_else(|| "#000000".to_string());

        // Map colors, with fallbacks to sensible defaults
        let background = get_var("background");
        let foreground = get_var("foreground");
        let accent = get_var("accent");

        // Derive accent_dim by reducing brightness
        let accent_dim = dim_color(&accent);

        let panel_bg = get_var("panel");
        let panel_border = get_var("border");
        let panel_border_focus = accent.clone();
        let header_bg = get_var("panelAlt");

        let text = foreground.clone();
        let text_dim = get_var("dimText");
        let text_muted = get_var("mutedText");

        let selection_bg = get_var("selectedBackground");
        let selection_fg = get_var("selectionForeground");

        let error = get_var("color1"); // Red
        let error_bg = get_var("panelError");
        let success = get_var("color2"); // Yellow/Green
        let warning = get_var("color3"); // Red variant

        let code_bg = get_var("panelAlt");
        let code_border = get_var("borderMuted");

        // Syntax highlighting from color palette
        let code_keyword = get_var("color5"); // Magenta
        let code_string = get_var("color2"); // Green
        let code_comment = get_var("dimText");
        let code_number = get_var("color3");
        let code_type = get_var("color4");
        let code_function = get_var("color4");

        Self {
            name: file.name,
            background,
            foreground,
            accent,
            accent_dim,
            panel_bg,
            panel_border,
            panel_border_focus,
            header_bg,
            text,
            text_dim,
            text_muted,
            selection_bg,
            selection_fg,
            error,
            error_bg,
            success,
            warning,
            code_bg,
            code_border,
            code_keyword,
            code_string,
            code_comment,
            code_number,
            code_type,
            code_function,
        }
    }

    /// Get the path to the Omarchy theme file.
    pub fn theme_path() -> Option<PathBuf> {
        expand_home(OMARCHY_THEME_PATH)
    }

    /// Get the path to Omarchy state directory (parent of theme/).
    pub fn state_dir() -> Option<PathBuf> {
        Self::theme_path().and_then(|p| p.parent()?.parent().map(|p| p.to_path_buf()))
    }
}

/// Expand ~ to home directory. Returns None if home dir cannot be determined.
fn expand_home(path: &str) -> Option<PathBuf> {
    if !path.starts_with('~') {
        return Some(PathBuf::from(path));
    }

    let home = dirs::home_dir()?;
    let rest = &path[1..];
    Some(home.join(rest.trim_start_matches('/')))
}

/// Reduce brightness of a hex color to create a "dim" version.
/// Takes a color like #e68e0d and returns a darker variant.
fn dim_color(hex: &str) -> String {
    if hex.len() != 7 || !hex.starts_with('#') {
        return hex.to_string();
    }

    let result = u32::from_str_radix(&hex[1..], 16).unwrap_or(0);
    let r = ((result >> 16) & 0xff) as f32 / 255.0;
    let g = ((result >> 8) & 0xff) as f32 / 255.0;
    let b = (result & 0xff) as f32 / 255.0;

    // Reduce brightness by 30%
    let r = ((r * 0.7) * 255.0) as u32;
    let g = ((g * 0.7) * 255.0) as u32;
    let b = ((b * 0.7) * 255.0) as u32;

    format!("#{:02x}{:02x}{:02x}", r, g, b)
}

/// Watch for changes to the Omarchy theme and reload when it changes.
///
/// Spawns a background thread that polls for theme file changes every 500ms.
/// When a change is detected, calls `on_change()`. Returns a handle to stop watching.
pub struct ThemeWatcher {
    stop_flag: Arc<Mutex<bool>>,
    thread_handle: Option<std::thread::JoinHandle<()>>,
}

impl ThemeWatcher {
    /// Start watching for Omarchy theme changes.
    pub fn start<F>(mut on_change: F) -> Self
    where
        F: FnMut() + Send + 'static,
    {
        let stop_flag = Arc::new(Mutex::new(false));
        let stop_flag_clone = Arc::clone(&stop_flag);

        let thread_handle = thread::spawn(move || {
            let mut last_modified: Option<std::time::SystemTime> = None;

            loop {
                {
                    let should_stop = *stop_flag_clone.lock().unwrap();
                    if should_stop {
                        break;
                    }
                }

                // Try to get the current theme file's modification time
                if let Some(path) = OmarchyTheme::theme_path() {
                    if let Ok(metadata) = fs::metadata(&path) {
                        if let Ok(modified) = metadata.modified() {
                            if let Some(last) = last_modified {
                                if modified > last {
                                    on_change();
                                }
                            }
                            last_modified = Some(modified);
                        }
                    }
                }

                thread::sleep(std::time::Duration::from_millis(500));
            }
        });

        Self {
            stop_flag,
            thread_handle: Some(thread_handle),
        }
    }

    /// Stop watching for theme changes.
    pub fn stop(mut self) {
        if let Ok(mut flag) = self.stop_flag.lock() {
            *flag = true;
        }
        if let Some(handle) = self.thread_handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for ThemeWatcher {
    fn drop(&mut self) {
        if let Ok(mut flag) = self.stop_flag.lock() {
            *flag = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dim_color_reduces_brightness() {
        let original = "#e68e0d";
        let dimmed = dim_color(original);
        assert_ne!(original, dimmed);
        assert!(dimmed.len() == 7);
        assert!(dimmed.starts_with('#'));
    }

    #[test]
    fn dim_color_handles_invalid_hex() {
        assert_eq!(dim_color("invalid"), "invalid");
        assert_eq!(dim_color("#12345"), "#12345");
    }

    #[test]
    fn expand_home_replaces_tilde() {
        let expanded = expand_home("~/.config/app").unwrap();
        assert!(!expanded.to_string_lossy().contains('~'));
    }

    #[test]
    fn expand_home_leaves_absolute_paths() {
        let path = expand_home("/etc/config").unwrap();
        assert_eq!(path, PathBuf::from("/etc/config"));
    }

    #[test]
    fn omarchy_theme_load_handles_missing_file() {
        // This should return None when not on Omarchy or file doesn't exist
        // We can't easily test the successful case without a real Omarchy install
        let theme = OmarchyTheme::load();
        // On a non-Omarchy system, this will be None; on Omarchy it should load
        // Either way, it doesn't panic
        let _ = theme;
    }

    #[test]
    fn omarchy_theme_from_file_creates_valid_theme() {
        let mut vars = HashMap::new();
        vars.insert("background".to_string(), "#121212".to_string());
        vars.insert("foreground".to_string(), "#bebebe".to_string());
        vars.insert("accent".to_string(), "#e68e0d".to_string());
        vars.insert("panel".to_string(), "#1c1c1c".to_string());
        vars.insert("panelAlt".to_string(), "#232323".to_string());
        vars.insert("border".to_string(), "#464646".to_string());
        vars.insert("borderMuted".to_string(), "#343434".to_string());
        vars.insert("dimText".to_string(), "#656565".to_string());
        vars.insert("mutedText".to_string(), "#848484".to_string());
        vars.insert("selectedBackground".to_string(), "#412d11".to_string());
        vars.insert("selectionForeground".to_string(), "#bebebe".to_string());
        vars.insert("panelError".to_string(), "#291b1b".to_string());
        vars.insert("color1".to_string(), "#D35F5F".to_string());
        vars.insert("color2".to_string(), "#FFC107".to_string());
        vars.insert("color3".to_string(), "#b91c1c".to_string());
        vars.insert("color4".to_string(), "#e68e0d".to_string());
        vars.insert("color5".to_string(), "#D35F5F".to_string());

        let file = OmarchyThemeFile {
            name: "omarchy-system".to_string(),
            vars,
            colors: HashMap::new(),
            export: HashMap::new(),
        };

        let theme = OmarchyTheme::from_file(file);
        assert_eq!(theme.background, "#121212");
        assert_eq!(theme.foreground, "#bebebe");
        assert_eq!(theme.accent, "#e68e0d");
        assert!(!theme.accent_dim.is_empty());
    }

    #[test]
    fn omarchy_theme_path_returns_reasonable_value() {
        if let Some(path) = OmarchyTheme::theme_path() {
            assert!(path.to_string_lossy().contains(".local/state/omarchy"));
        }
    }

    #[test]
    fn omarchy_theme_state_dir_returns_parent_of_theme() {
        if let Some(path) = OmarchyTheme::theme_path() {
            if let Some(state) = OmarchyTheme::state_dir() {
                // state_dir should be the parent of the theme dir
                assert!(path.starts_with(&state));
            }
        }
    }
}
