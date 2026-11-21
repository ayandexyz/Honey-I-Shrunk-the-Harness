//! A long "create account" form: eight sections of text fields, checkboxes,
//! switches, radio groups, dropdowns, sliders, team member rows and notes,
//! between a sticky header that summarizes validation and a footer with the
//! form's buttons.
//!
//! Every control is its own [`Entity`], as it would be in an application
//! built from reusable components. The header and footer read the fields
//! they summarize, so they depend on them; the section cards and the form
//! read nothing, so only the controls a frame touches have anything new to
//! draw.

use gpui::{
    AnyView, App, Context, Entity, FontWeight, Hsla, InputEvent, IntoElement, MouseMoveEvent,
    ParentElement, Render, SharedString, Styled, Window, div, point, prelude::*, px, relative, rgb,
};

pub fn scenarios() -> Vec<Box<dyn crate::Scenario>> {
    vec![
        Box::new(FormTyping),
        Box::new(FormValidation),
        Box::new(FormHover),
        Box::new(FormIdle),
    ]
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

fn c(hex: u32) -> Hsla {
    rgb(hex).into()
}

const BG: u32 = 0xf4f5f7;
const CARD: u32 = 0xffffff;
const BORDER: u32 = 0xd9dde3;
const BORDER_HOVER: u32 = 0xa9b1bd;
const TEXT: u32 = 0x1f2328;
const MUTED: u32 = 0x656d76;
const PLACEHOLDER: u32 = 0x9aa1aa;
const ACCENT: u32 = 0x2f6fed;
const ACCENT_SOFT: u32 = 0xe8f0fe;
const DANGER: u32 = 0xcf222e;
const DANGER_SOFT: u32 = 0xffebe9;
const SUCCESS: u32 = 0x1a7f37;
const SUCCESS_SOFT: u32 = 0xdafbe1;
const HOVER_BG: u32 = 0xf0f2f5;

// ---------------------------------------------------------------------------
// Text field
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Rule {
    Any,
    Email,
    Digits(usize),
    MinLen(usize),
    Phone,
}

struct TextField {
    label: SharedString,
    placeholder: SharedString,
    hint: Option<SharedString>,
    value: String,
    required: bool,
    rule: Rule,
    focused: bool,
    secret: bool,
}

impl TextField {
    fn new(label: &str, placeholder: &str, value: &str) -> Self {
        Self {
            label: SharedString::from(label.to_string()),
            placeholder: SharedString::from(placeholder.to_string()),
            hint: None,
            value: value.to_string(),
            required: false,
            rule: Rule::Any,
            focused: false,
            secret: false,
        }
    }

    fn required(mut self) -> Self {
        self.required = true;
        self
    }

    fn rule(mut self, rule: Rule) -> Self {
        self.rule = rule;
        self
    }

    fn hint(mut self, hint: &str) -> Self {
        self.hint = Some(SharedString::from(hint.to_string()));
        self
    }

    fn secret(mut self) -> Self {
        self.secret = true;
        self
    }

    fn is_filled(&self) -> bool {
        !self.value.trim().is_empty()
    }

    /// What is wrong with the value, if anything.
    fn error(&self) -> Option<String> {
        let value = self.value.trim();
        if value.is_empty() {
            return self.required.then(|| format!("{} is required", self.label));
        }
        match self.rule {
            Rule::Any => None,
            Rule::Email => {
                let valid = value
                    .split_once('@')
                    .is_some_and(|(user, domain)| !user.is_empty() && domain.contains('.'));
                (!valid).then(|| "Enter a valid email address".to_string())
            }
            Rule::Digits(n) => {
                let digits = value.chars().filter(|c| !c.is_whitespace()).count();
                let valid = digits == n
                    && value
                        .chars()
                        .all(|c| c.is_ascii_digit() || c.is_whitespace());
                (!valid).then(|| format!("Must be {n} digits"))
            }
            Rule::MinLen(n) => {
                (value.chars().count() < n).then(|| format!("Use at least {n} characters"))
            }
            Rule::Phone => {
                let valid = value
                    .chars()
                    .all(|c| c.is_ascii_digit() || " +-()".contains(c))
                    && value.chars().filter(char::is_ascii_digit).count() >= 7;
                (!valid).then(|| "Enter a valid phone number".to_string())
            }
        }
    }
}

impl Render for TextField {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let error = self.error();
        let border = if self.focused {
            c(ACCENT)
        } else if error.is_some() {
            c(DANGER)
        } else {
            c(BORDER)
        };
        let shown: SharedString = if self.secret {
            "•".repeat(self.value.chars().count()).into()
        } else {
            self.value.clone().into()
        };

        let mut input = div()
            .flex()
            .items_center()
            .h(px(34.))
            .px_3()
            .rounded_md()
            .border_1()
            .border_color(border)
            .bg(c(CARD))
            .text_sm()
            .overflow_hidden()
            .cursor_text()
            .hover(|s| s.border_color(c(BORDER_HOVER)));
        if self.focused {
            input = input.shadow_sm();
        }
        if self.value.is_empty() {
            if self.focused {
                input = input.child(caret());
            }
            input = input.child(
                div()
                    .text_color(c(PLACEHOLDER))
                    .whitespace_nowrap()
                    .child(self.placeholder.clone()),
            );
        } else {
            input = input
                .child(div().text_color(c(TEXT)).whitespace_nowrap().child(shown))
                .when(self.focused, |this| this.child(caret()));
        }

        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(field_label(&self.label, self.required))
            .child(input)
            .when_some(error, |this, error| {
                this.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_1()
                        .text_xs()
                        .text_color(c(DANGER))
                        .child("⚠")
                        .child(error),
                )
            })
            .when_some(self.hint.clone(), |this, hint| {
                this.child(div().text_xs().text_color(c(MUTED)).child(hint))
            })
    }
}

fn caret() -> impl IntoElement {
    div().w(px(1.5)).h(px(18.)).bg(c(ACCENT))
}

fn field_label(label: &SharedString, required: bool) -> impl IntoElement {
    div()
        .flex()
        .gap_1()
        .text_sm()
        .font_weight(FontWeight::MEDIUM)
        .text_color(c(TEXT))
        .child(label.clone())
        .when(required, |this| {
            this.child(div().text_color(c(DANGER)).child("*"))
        })
}

// ---------------------------------------------------------------------------
// Checkbox, switch, radio group, select, slider
// ---------------------------------------------------------------------------

struct Checkbox {
    label: SharedString,
    description: Option<SharedString>,
    checked: bool,
    required: bool,
}

impl Checkbox {
    fn new(label: &str, checked: bool) -> Self {
        Self {
            label: SharedString::from(label.to_string()),
            description: None,
            checked,
            required: false,
        }
    }

    fn description(mut self, description: &str) -> Self {
        self.description = Some(SharedString::from(description.to_string()));
        self
    }

    fn required(mut self) -> Self {
        self.required = true;
        self
    }

    fn error(&self) -> Option<String> {
        (self.required && !self.checked).then(|| format!("{} must be checked", self.label))
    }
}

impl Render for Checkbox {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let error = self.error();
        let box_ = div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(16.))
            .mt(px(2.))
            .rounded_sm()
            .border_1()
            .text_xs()
            .map(|this| {
                if self.checked {
                    this.bg(c(ACCENT))
                        .border_color(c(ACCENT))
                        .text_color(c(CARD))
                        .child("✓")
                } else if error.is_some() {
                    this.bg(c(CARD)).border_color(c(DANGER))
                } else {
                    this.bg(c(CARD)).border_color(c(BORDER))
                }
            });

        div()
            .flex()
            .gap_2()
            .p_1()
            .rounded_md()
            .cursor_pointer()
            .hover(|s| s.bg(c(HOVER_BG)))
            .child(box_)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .text_sm()
                            .text_color(c(TEXT))
                            .child(self.label.clone()),
                    )
                    .when_some(self.description.clone(), |this, description| {
                        this.child(div().text_xs().text_color(c(MUTED)).child(description))
                    })
                    .when_some(error, |this, error| {
                        this.child(div().text_xs().text_color(c(DANGER)).child(error))
                    }),
            )
    }
}

struct Switch {
    label: SharedString,
    description: SharedString,
    on: bool,
}

impl Switch {
    fn new(label: &str, description: &str, on: bool) -> Self {
        Self {
            label: SharedString::from(label.to_string()),
            description: SharedString::from(description.to_string()),
            on,
        }
    }
}

impl Render for Switch {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let track = div()
            .flex()
            .flex_none()
            .items_center()
            .w(px(36.))
            .h(px(20.))
            .p(px(2.))
            .rounded_full()
            .bg(if self.on { c(ACCENT) } else { c(BORDER) })
            .when(self.on, |this| this.justify_end())
            .child(div().size(px(16.)).rounded_full().bg(c(CARD)).shadow_sm());

        div()
            .flex()
            .items_center()
            .justify_between()
            .gap_4()
            .px_2()
            .py_1p5()
            .rounded_md()
            .cursor_pointer()
            .hover(|s| s.bg(c(HOVER_BG)))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .text_sm()
                            .text_color(c(TEXT))
                            .child(self.label.clone()),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(c(MUTED))
                            .child(self.description.clone()),
                    ),
            )
            .child(track)
    }
}

struct RadioGroup {
    label: SharedString,
    options: Vec<SharedString>,
    selected: usize,
}

impl RadioGroup {
    fn new(label: &str, options: &[&str], selected: usize) -> Self {
        Self {
            label: SharedString::from(label.to_string()),
            options: options
                .iter()
                .map(|o| SharedString::from(o.to_string()))
                .collect(),
            selected,
        }
    }
}

impl Render for RadioGroup {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(field_label(&self.label, false))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .children(self.options.iter().enumerate().map(|(ix, option)| {
                        let selected = ix == self.selected;
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .px_2()
                            .py_1()
                            .rounded_md()
                            .border_1()
                            .border_color(if selected { c(ACCENT) } else { c(BORDER) })
                            .when(selected, |this| this.bg(c(ACCENT_SOFT)))
                            .cursor_pointer()
                            .hover(|s| s.border_color(c(BORDER_HOVER)).bg(c(HOVER_BG)))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .size(px(14.))
                                    .rounded_full()
                                    .border_1()
                                    .border_color(if selected {
                                        c(ACCENT)
                                    } else {
                                        c(BORDER_HOVER)
                                    })
                                    .when(selected, |this| {
                                        this.child(div().size(px(6.)).rounded_full().bg(c(ACCENT)))
                                    }),
                            )
                            .child(div().text_sm().text_color(c(TEXT)).child(option.clone()))
                    })),
            )
    }
}

struct Select {
    label: SharedString,
    options: Vec<SharedString>,
    selected: usize,
}

impl Select {
    fn new(label: &str, options: &[&str], selected: usize) -> Self {
        Self {
            label: SharedString::from(label.to_string()),
            options: options
                .iter()
                .map(|o| SharedString::from(o.to_string()))
                .collect(),
            selected,
        }
    }
}

impl Render for Select {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(field_label(&self.label, false))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .h(px(34.))
                    .px_3()
                    .rounded_md()
                    .border_1()
                    .border_color(c(BORDER))
                    .bg(c(CARD))
                    .cursor_pointer()
                    .hover(|s| s.border_color(c(BORDER_HOVER)).bg(c(HOVER_BG)))
                    .child(
                        div()
                            .text_sm()
                            .text_color(c(TEXT))
                            .whitespace_nowrap()
                            .child(self.options[self.selected].clone()),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .text_xs()
                            .text_color(c(MUTED))
                            .child(format!("{} options", self.options.len()))
                            .child("▾"),
                    ),
            )
    }
}

struct Slider {
    label: SharedString,
    unit: SharedString,
    min: f32,
    max: f32,
    value: f32,
}

impl Slider {
    fn new(label: &str, unit: &str, min: f32, max: f32, value: f32) -> Self {
        Self {
            label: SharedString::from(label.to_string()),
            unit: SharedString::from(unit.to_string()),
            min,
            max,
            value,
        }
    }
}

impl Render for Slider {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let fraction = ((self.value - self.min) / (self.max - self.min)).clamp(0., 1.);
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(
                div()
                    .flex()
                    .justify_between()
                    .child(field_label(&self.label, false))
                    .child(div().text_sm().text_color(c(MUTED)).child(format!(
                        "{}{}",
                        self.value.round(),
                        self.unit
                    ))),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .h(px(20.))
                    .cursor_pointer()
                    .child(
                        div()
                            .relative()
                            .flex()
                            .items_center()
                            .w_full()
                            .h(px(6.))
                            .rounded_full()
                            .bg(c(BORDER))
                            .child(
                                div()
                                    .h_full()
                                    .w(relative(fraction))
                                    .rounded_full()
                                    .bg(c(ACCENT)),
                            )
                            .child(
                                div()
                                    .size(px(16.))
                                    .ml(px(-8.))
                                    .rounded_full()
                                    .border_2()
                                    .border_color(c(ACCENT))
                                    .bg(c(CARD))
                                    .hover(|s| s.bg(c(ACCENT_SOFT))),
                            ),
                    ),
            )
            .child(
                div()
                    .flex()
                    .justify_between()
                    .text_xs()
                    .text_color(c(PLACEHOLDER))
                    .child(format!("{}{}", self.min, self.unit))
                    .child(format!("{}{}", self.max, self.unit)),
            )
    }
}

// ---------------------------------------------------------------------------
// Notes, team members
// ---------------------------------------------------------------------------

struct NotesArea {
    label: SharedString,
    text: String,
    max_len: usize,
    focused: bool,
}

impl NotesArea {
    fn new(label: &str, text: &str, max_len: usize) -> Self {
        Self {
            label: SharedString::from(label.to_string()),
            text: text.to_string(),
            max_len,
            focused: false,
        }
    }

    fn error(&self) -> Option<String> {
        (self.text.chars().count() > self.max_len)
            .then(|| format!("{} is longer than {} characters", self.label, self.max_len))
    }
}

impl Render for NotesArea {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let count = self.text.chars().count();
        let error = self.error();
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(field_label(&self.label, false))
            .child(
                div()
                    .min_h(px(96.))
                    .p_3()
                    .rounded_md()
                    .border_1()
                    .border_color(if self.focused {
                        c(ACCENT)
                    } else if error.is_some() {
                        c(DANGER)
                    } else {
                        c(BORDER)
                    })
                    .bg(c(CARD))
                    .text_sm()
                    .line_height(px(20.))
                    .text_color(c(TEXT))
                    .cursor_text()
                    .hover(|s| s.border_color(c(BORDER_HOVER)))
                    .child(SharedString::from(self.text.clone())),
            )
            .child(
                div()
                    .flex()
                    .justify_between()
                    .text_xs()
                    .child(
                        div()
                            .text_color(c(DANGER))
                            .child(SharedString::from(error.unwrap_or_default())),
                    )
                    .child(
                        div()
                            .text_color(c(MUTED))
                            .child(format!("{count} / {}", self.max_len)),
                    ),
            )
    }
}

struct TeamMember {
    name: SharedString,
    email: SharedString,
    role: usize,
    pending: bool,
}

const ROLES: [&str; 4] = ["Owner", "Admin", "Editor", "Viewer"];

impl Render for TeamMember {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let initials: String = self
            .name
            .split_whitespace()
            .filter_map(|w| w.chars().next())
            .take(2)
            .collect();
        div()
            .flex()
            .items_center()
            .gap_3()
            .px_3()
            .py_2()
            .border_b_1()
            .border_color(c(BORDER))
            .hover(|s| s.bg(c(HOVER_BG)))
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .size(px(32.))
                    .rounded_full()
                    .bg(c(ACCENT_SOFT))
                    .text_color(c(ACCENT))
                    .text_xs()
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(initials),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .overflow_hidden()
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .text_sm()
                            .text_color(c(TEXT))
                            .child(self.name.clone())
                            .when(self.pending, |this| {
                                this.child(
                                    div()
                                        .px_1p5()
                                        .rounded_sm()
                                        .bg(c(0xfff8c5))
                                        .text_xs()
                                        .text_color(c(0x7d4e00))
                                        .child("Invite pending"),
                                )
                            }),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(c(MUTED))
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .child(self.email.clone()),
                    ),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .px_2()
                    .h(px(28.))
                    .rounded_md()
                    .border_1()
                    .border_color(c(BORDER))
                    .text_sm()
                    .text_color(c(TEXT))
                    .cursor_pointer()
                    .hover(|s| s.bg(c(HOVER_BG)).border_color(c(BORDER_HOVER)))
                    .child(ROLES[self.role])
                    .child(div().text_xs().text_color(c(MUTED)).child("▾")),
            )
            .child(
                div()
                    .px_2()
                    .h(px(28.))
                    .flex()
                    .items_center()
                    .rounded_md()
                    .text_sm()
                    .text_color(c(MUTED))
                    .cursor_pointer()
                    .hover(|s| s.bg(c(DANGER_SOFT)).text_color(c(DANGER)))
                    .child("Remove"),
            )
    }
}

// ---------------------------------------------------------------------------
// Section card, header, footer, form
// ---------------------------------------------------------------------------

struct FormSection {
    number: usize,
    title: SharedString,
    description: SharedString,
    /// Each control, and whether it spans the card's full width.
    fields: Vec<(AnyView, bool)>,
}

impl Render for FormSection {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .rounded_lg()
            .border_1()
            .border_color(c(BORDER))
            .bg(c(CARD))
            .shadow_sm()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .px_5()
                    .py_3()
                    .border_b_1()
                    .border_color(c(BORDER))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(px(24.))
                            .rounded_full()
                            .bg(c(ACCENT))
                            .text_color(c(CARD))
                            .text_xs()
                            .font_weight(FontWeight::BOLD)
                            .child(self.number.to_string()),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .text_base()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(c(TEXT))
                                    .child(self.title.clone()),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(c(MUTED))
                                    .child(self.description.clone()),
                            ),
                    ),
            )
            .child(div().flex().flex_wrap().gap_x_6().gap_y_4().p_5().children(
                self.fields.iter().map(|(field, wide)| {
                    div()
                        .when(*wide, |this| this.w_full())
                        .when(!*wide, |this| this.w(px(400.)))
                        .child(field.clone())
                }),
            ))
    }
}

/// The fields the header and footer summarize.
#[derive(Clone)]
struct Validated {
    text: Vec<Entity<TextField>>,
    checks: Vec<Entity<Checkbox>>,
    notes: Vec<Entity<NotesArea>>,
}

impl Validated {
    fn errors(&self, cx: &App) -> Vec<String> {
        let mut errors = Vec::new();
        errors.extend(self.text.iter().filter_map(|f| f.read(cx).error()));
        errors.extend(self.checks.iter().filter_map(|f| f.read(cx).error()));
        errors.extend(self.notes.iter().filter_map(|f| f.read(cx).error()));
        errors
    }

    /// The share of required fields that are filled and valid, in percent.
    fn completion(&self, cx: &App) -> u32 {
        let mut total = 0;
        let mut done = 0;
        for field in &self.text {
            let field = field.read(cx);
            if field.required {
                total += 1;
                if field.is_filled() && field.error().is_none() {
                    done += 1;
                }
            }
        }
        for check in &self.checks {
            let check = check.read(cx);
            if check.required {
                total += 1;
                if check.checked {
                    done += 1;
                }
            }
        }
        (done * 100u32).checked_div(total).unwrap_or(100)
    }
}

struct AutosaveClock {
    seconds: usize,
}

impl Render for AutosaveClock {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let s = self.seconds;
        div().text_xs().text_color(c(MUTED)).child(format!(
            "Draft autosaved · {:02}:{:02}:{:02} ago",
            s / 3600,
            s / 60 % 60,
            s % 60
        ))
    }
}

struct FormHeader {
    fields: Validated,
    clock: Entity<AutosaveClock>,
}

impl Render for FormHeader {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let errors = self.fields.errors(cx);
        let completion = self.fields.completion(cx);
        let badge = if errors.is_empty() {
            div()
                .bg(c(SUCCESS_SOFT))
                .text_color(c(SUCCESS))
                .child("Ready to submit")
        } else {
            div()
                .bg(c(DANGER_SOFT))
                .text_color(c(DANGER))
                .child(format!(
                    "{} error{}",
                    errors.len(),
                    if errors.len() == 1 { "" } else { "s" }
                ))
        };

        div()
            .flex()
            .flex_col()
            .flex_none()
            .gap_2()
            .px_8()
            .py_3()
            .bg(c(CARD))
            .border_b_1()
            .border_color(c(BORDER))
            .shadow_sm()
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .text_lg()
                                    .font_weight(FontWeight::BOLD)
                                    .text_color(c(TEXT))
                                    .child("Create your workspace account"),
                            )
                            .child(self.clock.clone()),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_3()
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(c(MUTED))
                                    .child(format!("{completion}% complete")),
                            )
                            .child(badge.px_2().py_0p5().rounded_full().text_xs()),
                    ),
            )
            .child(
                div().h(px(4.)).w_full().rounded_full().bg(c(BORDER)).child(
                    div()
                        .h_full()
                        .w(relative(completion as f32 / 100.))
                        .rounded_full()
                        .bg(if errors.is_empty() {
                            c(SUCCESS)
                        } else {
                            c(ACCENT)
                        }),
                ),
            )
            .when(!errors.is_empty(), |this| {
                this.child(
                    div()
                        .flex()
                        .gap_2()
                        .text_xs()
                        .text_color(c(DANGER))
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .children(errors.into_iter().take(3).map(|e| {
                            div()
                                .px_1p5()
                                .rounded_sm()
                                .bg(c(DANGER_SOFT))
                                .cursor_pointer()
                                .hover(|s| s.underline())
                                .child(e)
                        })),
                )
            })
    }
}

struct FormFooter {
    fields: Validated,
}

fn button(label: &'static str) -> gpui::Div {
    div()
        .flex()
        .items_center()
        .h(px(34.))
        .px_4()
        .rounded_md()
        .text_sm()
        .font_weight(FontWeight::MEDIUM)
        .cursor_pointer()
        .child(label)
}

impl Render for FormFooter {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let error_count = self.fields.errors(cx).len();
        let can_submit = error_count == 0;
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_between()
            .px_8()
            .py_3()
            .bg(c(CARD))
            .border_t_1()
            .border_color(c(BORDER))
            .child(div().text_xs().text_color(c(MUTED)).child(if can_submit {
                SharedString::from("Everything looks good.")
            } else {
                SharedString::from(format!("Fix {error_count} field(s) before submitting."))
            }))
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(
                        button("Cancel")
                            .text_color(c(TEXT))
                            .hover(|s| s.bg(c(HOVER_BG))),
                    )
                    .child(
                        button("Save draft")
                            .border_1()
                            .border_color(c(BORDER))
                            .text_color(c(TEXT))
                            .hover(|s| s.bg(c(HOVER_BG)).border_color(c(BORDER_HOVER))),
                    )
                    .child(if can_submit {
                        button("Create account")
                            .bg(c(ACCENT))
                            .text_color(c(CARD))
                            .hover(|s| s.bg(c(0x1f5ad6)))
                    } else {
                        button("Create account")
                            .bg(c(0xa8c1f5))
                            .text_color(c(CARD))
                            .cursor_not_allowed()
                    }),
            )
    }
}

/// The form's root view, with handles on the controls the scenarios drive.
struct Form {
    header: Entity<FormHeader>,
    footer: Entity<FormFooter>,
    clock: Entity<AutosaveClock>,
    sections: Vec<Entity<FormSection>>,
    /// Every text field, in tab order.
    text_fields: Vec<Entity<TextField>>,
    focused: Option<usize>,
    first_name: Entity<TextField>,
    email: Entity<TextField>,
    zip: Entity<TextField>,
    card_number: Entity<TextField>,
    password: Entity<TextField>,
    terms: Entity<Checkbox>,
    notes: Entity<NotesArea>,
    #[cfg_attr(not(test), allow(dead_code))]
    control_count: usize,
}

impl Render for Form {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(c(BG))
            .font_family(".SystemUIFont")
            .text_color(c(TEXT))
            .child(self.header.clone())
            .child(
                div()
                    .id("form-body")
                    .flex_1()
                    .min_h(px(0.))
                    .overflow_y_scroll()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_5()
                            .px_8()
                            .py_6()
                            .children(self.sections.iter().cloned()),
                    ),
            )
            .child(self.footer.clone())
    }
}

/// Collects the controls of one section as they are created.
struct SectionBuilder<'a> {
    fields: Vec<(AnyView, bool)>,
    text: &'a mut Vec<Entity<TextField>>,
    count: &'a mut usize,
}

impl SectionBuilder<'_> {
    fn text(&mut self, field: TextField, cx: &mut App) -> Entity<TextField> {
        let entity = cx.new(|_| field);
        self.text.push(entity.clone());
        self.fields.push((entity.clone().into(), false));
        *self.count += 1;
        entity
    }

    fn add<V: Render>(&mut self, view: V, wide: bool, cx: &mut App) -> Entity<V> {
        let entity = cx.new(|_| view);
        self.fields.push((entity.clone().into(), wide));
        *self.count += 1;
        entity
    }
}

const NOTES_TEXT: &str = "Please deliver between 9am and 5pm on weekdays. The loading dock \
    is on the north side of the building, next to the bike racks; ring the bell marked \
    \"Receiving\" and someone from operations will sign for the package. If nobody answers, \
    leave it with the front desk in the lobby rather than at the door. For large orders we \
    would appreciate a call thirty minutes ahead so we can clear space in the storeroom.";

fn build_form(cx: &mut App) -> Entity<Form> {
    let mut text_fields = Vec::new();
    let mut count = 0;
    let mut sections = Vec::new();

    macro_rules! section {
        ($title:expr, $description:expr, |$b:ident| $body:block) => {{
            let mut $b = SectionBuilder {
                fields: Vec::new(),
                text: &mut text_fields,
                count: &mut count,
            };
            let result = $body;
            let fields = $b.fields;
            let number = sections.len() + 1;
            sections.push(cx.new(|_| FormSection {
                number,
                title: $title.into(),
                description: $description.into(),
                fields,
            }));
            result
        }};
    }

    let (first_name, email) = section!(
        "Personal information",
        "How you appear to your teammates and how we reach you.",
        |b| {
            let first = b.text(TextField::new("First name", "Jane", "Jane").required(), cx);
            b.text(TextField::new("Last name", "Doe", "Doe").required(), cx);
            b.text(
                TextField::new("Display name", "How others see you", "jdoe")
                    .hint("Shown on comments and mentions."),
                cx,
            );
            let email = b.text(
                TextField::new("Email", "you@example.com", "jane.doe@example.com")
                    .required()
                    .rule(Rule::Email),
                cx,
            );
            b.text(
                TextField::new("Phone", "+1 555 000 0000", "+1 415 555 0132").rule(Rule::Phone),
                cx,
            );
            b.text(
                TextField::new("Date of birth", "YYYY-MM-DD", "1990-04-12"),
                cx,
            );
            b.text(
                TextField::new("Job title", "e.g. Product designer", "Staff engineer"),
                cx,
            );
            b.text(
                TextField::new("Company", "Acme Inc.", "Northwind Traders"),
                cx,
            );
            b.text(TextField::new("Website", "https://", ""), cx);
            b.add(
                Select::new(
                    "Pronouns",
                    &["she/her", "he/him", "they/them", "Prefer not to say"],
                    0,
                ),
                false,
                cx,
            );
            b.add(
                Select::new(
                    "Language",
                    &[
                        "English (US)",
                        "English (UK)",
                        "Deutsch",
                        "Français",
                        "日本語",
                    ],
                    0,
                ),
                false,
                cx,
            );
            (first, email)
        }
    );

    let zip = section!("Address", "Used for shipping and on your invoices.", |b| {
        b.text(
            TextField::new("Street address", "123 Main St", "500 Howard Street").required(),
            cx,
        );
        b.text(
            TextField::new("Apartment, suite", "Optional", "Suite 300"),
            cx,
        );
        b.text(
            TextField::new("City", "City", "San Francisco").required(),
            cx,
        );
        b.add(
            Select::new(
                "State / province",
                &["California", "New York", "Texas", "Washington", "Oregon"],
                0,
            ),
            false,
            cx,
        );
        let zip = b.text(
            TextField::new("ZIP code", "00000", "94105")
                .required()
                .rule(Rule::Digits(5)),
            cx,
        );
        b.add(
            Select::new(
                "Country",
                &["United States", "Canada", "Germany", "Japan", "Brazil"],
                0,
            ),
            false,
            cx,
        );
        b.add(
            Checkbox::new("Billing address is the same as shipping", false),
            true,
            cx,
        );
        b.text(
            TextField::new("Billing street", "123 Main St", "1 Market Street"),
            cx,
        );
        b.text(TextField::new("Billing city", "City", "San Francisco"), cx);
        b.text(
            TextField::new("Billing ZIP", "00000", "94111").rule(Rule::Digits(5)),
            cx,
        );
        zip
    });

    let card_number = section!(
        "Payment",
        "You won't be charged until your trial ends.",
        |b| {
            b.text(
                TextField::new("Name on card", "Full name", "Jane Doe").required(),
                cx,
            );
            let card = b.text(
                TextField::new("Card number", "0000 0000 0000 0000", "4242 4242 4242 4242")
                    .required()
                    .rule(Rule::Digits(16)),
                cx,
            );
            b.text(TextField::new("Expiry", "MM/YY", "08/29").required(), cx);
            b.text(
                TextField::new("CVC", "123", "123")
                    .required()
                    .rule(Rule::Digits(3))
                    .secret(),
                cx,
            );
            b.add(
                RadioGroup::new("Plan", &["Monthly", "Annual (save 20%)", "Lifetime"], 1),
                true,
                cx,
            );
            b.add(
                Select::new("Currency", &["USD $", "EUR €", "GBP £", "JPY ¥"], 0),
                false,
                cx,
            );
            b.add(Slider::new("Seats", "", 1., 100., 12.), false, cx);
            b.text(
                TextField::new("Promo code", "Optional", "").hint("Codes are case-insensitive."),
                cx,
            );
            b.add(
                Checkbox::new("Save this card for future purchases", true)
                    .description("Stored securely by our payment processor."),
                false,
                cx,
            );
            card
        }
    );

    section!(
        "Preferences",
        "Tune the editor and the interface to your taste.",
        |b| {
            b.add(
                Select::new("Theme", &["System", "Light", "Dark"], 0),
                false,
                cx,
            );
            b.add(
                Select::new(
                    "Time zone",
                    &[
                        "(UTC-08:00) Pacific Time",
                        "(UTC-05:00) Eastern Time",
                        "(UTC+00:00) London",
                        "(UTC+09:00) Tokyo",
                    ],
                    0,
                ),
                false,
                cx,
            );
            b.add(
                Select::new(
                    "Date format",
                    &["2026-09-28", "09/28/2026", "28.09.2026"],
                    0,
                ),
                false,
                cx,
            );
            b.add(
                RadioGroup::new("Density", &["Compact", "Comfortable", "Spacious"], 1),
                false,
                cx,
            );
            b.add(Slider::new("Font size", "px", 10., 24., 14.), false, cx);
            b.add(Slider::new("Line height", "%", 100., 200., 150.), false, cx);
            for (label, description, on) in [
                (
                    "Reduce motion",
                    "Minimize animations and transitions.",
                    false,
                ),
                ("Show line numbers", "In code blocks and the editor.", true),
                ("Autosave", "Save drafts every few seconds.", true),
                (
                    "Spell check",
                    "Underline misspelled words as you type.",
                    true,
                ),
            ] {
                (b.add(Switch::new(label, description, on), false, cx));
            }
            b.add(
                Checkbox::new("Enable beta features", false)
                    .description("Try new features before they ship. They may change."),
                false,
                cx,
            );
        }
    );

    section!(
        "Notifications",
        "Choose what we tell you about and where.",
        |b| {
            for (label, description, on) in [
                ("Mentions by email", "When someone @mentions you.", true),
                ("Mentions by push", "On your phone and desktop.", true),
                (
                    "Comments on your posts",
                    "Replies to anything you wrote.",
                    true,
                ),
                (
                    "Weekly summary",
                    "A digest of what happened this week.",
                    false,
                ),
                ("Product updates", "New features and improvements.", false),
                ("Security alerts", "Sign-ins from new devices.", true),
                ("Billing reminders", "Before your plan renews.", true),
                (
                    "SMS for urgent issues",
                    "Outages that affect your workspace.",
                    false,
                ),
            ] {
                (b.add(Switch::new(label, description, on), false, cx));
            }
            b.add(
                RadioGroup::new(
                    "Digest frequency",
                    &["Never", "Daily", "Weekly", "Monthly"],
                    2,
                ),
                true,
                cx,
            );
            b.add(
                Slider::new("Quiet hours start", ":00", 0., 23., 22.),
                false,
                cx,
            );
            b.add(
                Select::new("Notification sound", &["Chime", "Ding", "Pop", "None"], 0),
                false,
                cx,
            );
        }
    );

    let (password, terms) = section!(
        "Security",
        "Protect your account with a strong password and two-factor authentication.",
        |b| {
            let password = b.text(
                TextField::new(
                    "Password",
                    "At least 12 characters",
                    "correct-horse-battery",
                )
                .required()
                .rule(Rule::MinLen(12))
                .secret(),
                cx,
            );
            b.text(
                TextField::new(
                    "Confirm password",
                    "Repeat the password",
                    "correct-horse-battery",
                )
                .required()
                .rule(Rule::MinLen(12))
                .secret(),
                cx,
            );
            (b.add(
                Switch::new(
                    "Two-factor authentication",
                    "Require a second step when signing in.",
                    true,
                ),
                false,
                cx,
            ));
            b.add(
                RadioGroup::new(
                    "Second factor",
                    &["Authenticator app", "SMS", "Security key"],
                    0,
                ),
                false,
                cx,
            );
            b.add(
                Select::new(
                    "Sign out after",
                    &["1 hour", "8 hours", "1 day", "30 days"],
                    2,
                ),
                false,
                cx,
            );
            b.text(
                TextField::new(
                    "Recovery email",
                    "backup@example.com",
                    "jane@personal.example",
                )
                .rule(Rule::Email),
                cx,
            );
            b.text(
                TextField::new(
                    "Security question answer",
                    "Something only you know",
                    "Rover",
                )
                .secret(),
                cx,
            );
            b.add(
                Checkbox::new("Email me about sign-ins from new devices", true),
                false,
                cx,
            );
            let terms = b.add(
                Checkbox::new("I agree to the Terms of Service and Privacy Policy", true)
                    .required(),
                true,
                cx,
            );
            (password, terms)
        }
    );

    section!(
        "Team members",
        "Invite the people you work with. You can change roles later.",
        |b| {
            for (ix, (name, email)) in [
                ("Jane Doe", "jane.doe@example.com"),
                ("Omar Haddad", "omar@northwind.example"),
                ("Li Wei", "li.wei@northwind.example"),
                ("Sofia Rossi", "sofia.rossi@northwind.example"),
                ("Kwame Mensah", "kwame@northwind.example"),
                ("Ana Souza", "ana.souza@contractor.example"),
            ]
            .into_iter()
            .enumerate()
            {
                b.add(
                    TeamMember {
                        name: name.into(),
                        email: email.into(),
                        role: ix.min(3),
                        pending: ix >= 4,
                    },
                    true,
                    cx,
                );
            }
            b.text(
                TextField::new("Invite by email", "name@company.com", "").rule(Rule::Email),
                cx,
            );
            b.add(
                Select::new("Default role for invites", &ROLES, 2),
                false,
                cx,
            );
        }
    );

    let notes = section!("Notes", "Anything else we should know?", |b| {
        let notes = b.add(
            NotesArea::new("Delivery instructions", NOTES_TEXT, 600),
            true,
            cx,
        );
        b.add(
            NotesArea::new(
                "How did you hear about us?",
                "A colleague recommended it after we moved our design reviews over.",
                280,
            ),
            true,
            cx,
        );
        b.text(
            TextField::new("Referral code", "Optional", "FRIEND-2026"),
            cx,
        );
        b.add(
            Slider::new("How likely are you to recommend us?", "", 0., 10., 8.),
            false,
            cx,
        );
        b.add(
            Checkbox::new("Subscribe to the monthly newsletter", false),
            false,
            cx,
        );
        notes
    });

    let validated = Validated {
        text: text_fields.clone(),
        checks: vec![terms.clone()],
        notes: vec![notes.clone()],
    };
    let clock = cx.new(|_| AutosaveClock { seconds: 0 });
    let header = cx.new(|_| FormHeader {
        fields: validated.clone(),
        clock: clock.clone(),
    });
    let footer = cx.new(|_| FormFooter { fields: validated });

    cx.new(|_| Form {
        header,
        footer,
        clock,
        sections,
        text_fields,
        focused: None,
        first_name,
        email,
        zip,
        card_number,
        password,
        terms,
        notes,
        control_count: count,
    })
}

fn form(root: &AnyView) -> Entity<Form> {
    root.clone().downcast::<Form>().unwrap()
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/// What the typist types, one character a frame.
const TYPED: &str = "the quick brown fox jumps over the lazy dog 0123456789 ";

/// Frames a field keeps focus before tab moves to the next one.
const FRAMES_PER_FIELD: usize = 20;

struct FormTyping;

impl crate::Scenario for FormTyping {
    fn name(&self) -> &'static str {
        "form-typing"
    }

    fn description(&self) -> &'static str {
        "A long account form; one character is typed into the focused text field each frame, and focus tabs to the next field every 20 frames."
    }

    fn build(&self, _: &mut Window, cx: &mut App) -> AnyView {
        build_form(cx).into()
    }

    fn step(&self, root: &AnyView, frame: usize, _: &mut Window, cx: &mut App) {
        let form = form(root);
        let (fields, previous) = {
            let form = form.read(cx);
            (form.text_fields.clone(), form.focused)
        };
        let target = (frame / FRAMES_PER_FIELD) % fields.len();
        if previous != Some(target) {
            // Tab: the old field loses focus, the new one gains it.
            if let Some(previous) = previous {
                fields[previous].update(cx, |field, cx| {
                    field.focused = false;
                    cx.notify();
                });
            }
            fields[target].update(cx, |field, cx| {
                field.focused = true;
                cx.notify();
            });
            form.update(cx, |form, _| form.focused = Some(target));
        }
        let ch = TYPED.as_bytes()[frame % TYPED.len()] as char;
        fields[target].update(cx, |field, cx| {
            if field.value.chars().count() >= 40 {
                field.value.clear();
            }
            field.value.push(ch);
            cx.notify();
        });
    }
}

struct FormValidation;

impl crate::Scenario for FormValidation {
    fn name(&self) -> &'static str {
        "form-validation"
    }

    fn description(&self) -> &'static str {
        "A long account form; each frame one field flips between valid and invalid, changing its error text, the header's error summary and completion, and the footer."
    }

    fn build(&self, _: &mut Window, cx: &mut App) -> AnyView {
        build_form(cx).into()
    }

    fn step(&self, root: &AnyView, frame: usize, _: &mut Window, cx: &mut App) {
        let form = form(root);
        let form = form.read(cx);
        let (first_name, email, zip, card, password, terms, notes) = (
            form.first_name.clone(),
            form.email.clone(),
            form.zip.clone(),
            form.card_number.clone(),
            form.password.clone(),
            form.terms.clone(),
            form.notes.clone(),
        );
        let flip = |field: &Entity<TextField>, valid: &str, invalid: &str, cx: &mut App| {
            field.update(cx, |field, cx| {
                field.value = if field.value == valid { invalid } else { valid }.to_string();
                cx.notify();
            });
        };
        match frame % 7 {
            0 => flip(&email, "jane.doe@example.com", "jane.doe@", cx),
            1 => terms.update(cx, |terms, cx| {
                terms.checked = !terms.checked;
                cx.notify();
            }),
            2 => flip(&zip, "94105", "9410", cx),
            3 => flip(&card, "4242 4242 4242 4242", "4242 4242", cx),
            4 => flip(&password, "correct-horse-battery", "hunter2", cx),
            5 => flip(&first_name, "Jane", "", cx),
            _ => notes.update(cx, |notes, cx| {
                if notes.text.len() > NOTES_TEXT.len() {
                    notes.text.truncate(NOTES_TEXT.len());
                } else {
                    notes.text.push_str(
                        " Also, the elevator is out of service on Fridays, so please use \
                         the freight lift at the back of the building instead.",
                    );
                    notes.text.push_str(
                        " Our receiving team rotates, so ask for whoever is on shift today.",
                    );
                }
                cx.notify();
            }),
        }
    }
}

struct FormHover;

impl crate::Scenario for FormHover {
    fn name(&self) -> &'static str {
        "form-hover"
    }

    fn description(&self) -> &'static str {
        "A long account form; the mouse sweeps across the fields, one move event a frame, so hover styles come and go."
    }

    fn build(&self, _: &mut Window, cx: &mut App) -> AnyView {
        build_form(cx).into()
    }

    fn step(&self, _: &AnyView, frame: usize, window: &mut Window, cx: &mut App) {
        // Sweep rows left to right, top to bottom, over the visible form,
        // including the footer's buttons.
        const COLUMNS: usize = 24;
        const ROWS: usize = 28;
        let viewport = window.viewport_size();
        let width = f32::from(viewport.width).max(200.);
        let height = f32::from(viewport.height).max(200.);
        let column = frame % COLUMNS;
        let row = (frame / COLUMNS) % ROWS;
        let x = 12. + (width - 24.) * column as f32 / (COLUMNS - 1) as f32;
        let y = 8. + (height - 16.) * row as f32 / (ROWS - 1) as f32;
        window.dispatch_event(
            MouseMoveEvent {
                position: point(px(x), px(y)),
                pressed_button: None,
                modifiers: Default::default(),
            }
            .to_platform_input(),
            cx,
        );
    }
}

struct FormIdle;

impl crate::Scenario for FormIdle {
    fn name(&self) -> &'static str {
        "form-idle"
    }

    fn description(&self) -> &'static str {
        "A long account form at rest; only the header's small autosave clock ticks each frame."
    }

    fn build(&self, _: &mut Window, cx: &mut App) -> AnyView {
        build_form(cx).into()
    }

    fn step(&self, root: &AnyView, frame: usize, _: &mut Window, cx: &mut App) {
        let form = form(root);
        let clock = form.read(cx).clock.clone();
        clock.update(cx, |clock, cx| {
            clock.seconds = frame;
            cx.notify();
        });
    }
}

#[cfg(test)]
mod tests {
    use gpui::{AnyView, Entity, TestAppContext, prelude::*};

    struct Host(Entity<super::Form>);

    impl gpui::Render for Host {
        fn render(
            &mut self,
            _: &mut gpui::Window,
            _: &mut gpui::Context<Self>,
        ) -> impl IntoElement {
            gpui::div().size_full().child(self.0.clone())
        }
    }

    #[gpui::test]
    fn form_builds_and_steps(cx: &mut TestAppContext) {
        let (host, cx) = cx.add_window_view(|_, cx| Host(super::build_form(cx)));
        let root: AnyView = cx.read(|cx| host.read(cx).0.clone().into());
        let count = cx.read(|cx| host.read(cx).0.read(cx).control_count);
        assert!((60..=100).contains(&count), "{count} controls");
        for scenario in super::scenarios() {
            for frame in 0..30 {
                cx.update(|window, cx| scenario.step(&root, frame, window, cx));
                cx.run_until_parked();
            }
        }
    }

    #[test]
    fn scenario_names_are_unique() {
        let scenarios = super::scenarios();
        let mut names: Vec<_> = scenarios.iter().map(|s| s.name()).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), scenarios.len());
    }
}
