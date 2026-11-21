//! The scenarios, one module each. Every module exports
//! `pub fn scenarios() -> Vec<Box<dyn crate::Scenario>>`.

pub mod form;
pub mod layout;
pub mod list;
pub mod settings;
pub mod table;
