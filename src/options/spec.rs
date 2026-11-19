//! The settings spec: one declarative table behind the setting surfaces the
//! command line does not own.
//!
//! A setting speaks on three surfaces: the CLI flags clap derives from the
//! [`Settings`] struct, the `WIKICC_*` environment variables
//! ([`crate::env`]) and the `.wikicc.json` keys ([`crate::config`]). The
//! struct is the source of the shape and of the command line; [`SETTINGS`]
//! is the source of the rest. Per setting it records the [`Field`] the
//! entry fills, the full variable name that addresses it and its [`Kind`],
//! which carries the value grammar both readers apply. The environment
//! reader looks its entries up by variable name ([`SettingSpec::by_var`]),
//! the configuration reader by key ([`SettingSpec::by_key`]), and both
//! store what they parsed through [`SettingSpec::apply_env`] and
//! [`SettingSpec::apply_config`] — a new setting is one struct field and
//! one entry here, never a third hand-written match arm to keep in step.
//!
//! The per-kind parsing owns every message the two readers produce for
//! their values; the callers keep only their source policies: which names
//! count as spoken, what a blank value means and what an unknown name or
//! key costs.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::format::OutputFormat;
use super::language::Language;
use super::normalize_excludes;
use super::settings::Settings;
use crate::error::{Error, Result};

/// Which field of [`Settings`] a spec entry writes.
///
/// One variant per field, so a rename or a removal in the struct fails to
/// compile here instead of silently skipping the setting; the variants
/// mirror the struct's declaration order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Field {
    Out,
    Format,
    Title,
    Strict,
    Home,
    Exclude,
    Favicon,
    Password,
    Jobs,
    Language,
}

impl Field {
    /// The field's name on every surface that spells it out: the struct
    /// field itself, the CLI long flag and the configuration key.
    pub(crate) fn name(self) -> &'static str {
        match self {
            Field::Out => "out",
            Field::Format => "format",
            Field::Title => "title",
            Field::Strict => "strict",
            Field::Home => "home",
            Field::Exclude => "exclude",
            Field::Favicon => "favicon",
            Field::Password => "password",
            Field::Jobs => "jobs",
            Field::Language => "language",
        }
    }

    /// Store a plain text value: the field's `Some` is the value as written.
    fn store_text(self, settings: &mut Settings, value: String) {
        match self {
            Field::Title => settings.title = Some(value),
            Field::Home => settings.home = Some(value),
            Field::Favicon => settings.favicon = Some(value),
            Field::Password => settings.password = Some(value),
            Field::Out
            | Field::Format
            | Field::Strict
            | Field::Exclude
            | Field::Jobs
            | Field::Language => {
                unreachable!("'{}' does not carry a text value", self.name())
            }
        }
    }

    /// Store a directory path value.
    fn store_path(self, settings: &mut Settings, value: PathBuf) {
        match self {
            Field::Out => settings.out = Some(value),
            Field::Format
            | Field::Title
            | Field::Strict
            | Field::Home
            | Field::Exclude
            | Field::Favicon
            | Field::Password
            | Field::Jobs
            | Field::Language => {
                unreachable!("'{}' does not carry a path value", self.name())
            }
        }
    }

    /// Store a boolean gate value.
    fn store_flag(self, settings: &mut Settings, value: bool) {
        match self {
            Field::Strict => settings.strict = Some(value),
            Field::Out
            | Field::Format
            | Field::Title
            | Field::Home
            | Field::Exclude
            | Field::Favicon
            | Field::Password
            | Field::Jobs
            | Field::Language => {
                unreachable!("'{}' does not carry a boolean value", self.name())
            }
        }
    }

    /// Store an output format value.
    fn store_format(self, settings: &mut Settings, value: OutputFormat) {
        match self {
            Field::Format => settings.format = Some(value),
            Field::Out
            | Field::Title
            | Field::Strict
            | Field::Home
            | Field::Exclude
            | Field::Favicon
            | Field::Password
            | Field::Jobs
            | Field::Language => {
                unreachable!("'{}' does not carry a format value", self.name())
            }
        }
    }

    /// Store a directory list value.
    fn store_list(self, settings: &mut Settings, value: Vec<String>) {
        match self {
            Field::Exclude => settings.exclude = Some(value),
            Field::Out
            | Field::Format
            | Field::Title
            | Field::Strict
            | Field::Home
            | Field::Favicon
            | Field::Password
            | Field::Jobs
            | Field::Language => {
                unreachable!("'{}' does not carry a list value", self.name())
            }
        }
    }

    /// Store a worker-thread count value.
    fn store_count(self, settings: &mut Settings, value: u32) {
        match self {
            Field::Jobs => settings.jobs = Some(value),
            Field::Out
            | Field::Format
            | Field::Title
            | Field::Strict
            | Field::Home
            | Field::Exclude
            | Field::Favicon
            | Field::Password
            | Field::Language => {
                unreachable!("'{}' does not carry a count value", self.name())
            }
        }
    }

    /// Store a reader interface language value.
    fn store_language(self, settings: &mut Settings, value: Language) {
        match self {
            Field::Language => settings.language = Some(value),
            Field::Out
            | Field::Format
            | Field::Title
            | Field::Strict
            | Field::Home
            | Field::Exclude
            | Field::Favicon
            | Field::Password
            | Field::Jobs => {
                unreachable!("'{}' does not carry a language value", self.name())
            }
        }
    }
}

/// How one setting's value is spelled and checked on the two non-CLI
/// surfaces, which is also where the readers' value messages live.
#[derive(Debug)]
pub(crate) enum Kind {
    /// A plain string, kept verbatim (`title`).
    Text,
    /// A string that must name something: blank after trimming is a hard
    /// error in the configuration file, where the noun completes the
    /// message (`home`/`password`: "string", `favicon`: "file path"). The
    /// environment has no such error — a blank variable simply did not
    /// speak.
    RequiredText(&'static str),
    /// A non-empty directory path (`out`). The environment keeps it as
    /// written — a relative value is resolved against the working directory
    /// later, exactly like a command line `--out` — while the configuration
    /// file resolves it against the folder the file lives in.
    RequiredPath(&'static str),
    /// A boolean gate (`strict`). The configuration file speaks JSON
    /// booleans; the environment spells them `true`, `false`, `1` or `0`.
    Flag,
    /// The output artifact format (`format`).
    Format,
    /// A list of directory paths (`exclude`). The environment joins them
    /// with commas; the configuration file carries a JSON array. Both hand
    /// the winning list to the shared normalization in the merge.
    List,
    /// A positive worker-thread count (`jobs`). The environment spells it a
    /// decimal integer; the configuration file carries a JSON number. Zero
    /// and non-integers are rejected: a build with no worker threads cannot
    /// run.
    Count,
    /// The reader interface language (`language`). Both surfaces spell it a
    /// language code — `en` or `zh`, letter case ignored — and an unknown
    /// code is rejected: the reader carries no dictionary for it.
    Language,
}

/// One setting's coordinates: which field the entry fills, the full
/// `WIKICC_*` variable that addresses it and how its value is spelled.
#[derive(Debug)]
pub(crate) struct SettingSpec {
    /// The `Settings` field the entry writes; also the CLI flag and the
    /// configuration key.
    pub(crate) field: Field,
    /// The full environment variable name, prefix included.
    pub(crate) var: &'static str,
    /// The value grammar both readers apply.
    pub(crate) kind: Kind,
}

impl SettingSpec {
    /// The entry a full `WIKICC_*` variable name belongs to, if any.
    pub(crate) fn by_var(name: &str) -> Option<&'static SettingSpec> {
        SETTINGS.iter().find(|spec| spec.var == name)
    }

    /// The entry a configuration key belongs to, if any.
    pub(crate) fn by_key(key: &str) -> Option<&'static SettingSpec> {
        SETTINGS.iter().find(|spec| spec.field.name() == key)
    }

    /// Apply an environment value to the entry's field.
    ///
    /// The environment speaks strings, and the caller hands the value over
    /// already trimmed and non-empty — a blank variable never reaches this
    /// point. A value the kind cannot understand is a hard
    /// [`Error::InvalidInput`] naming the variable: silently dropping an
    /// explicit instruction would produce a site nobody asked for.
    pub(crate) fn apply_env(&self, settings: &mut Settings, value: &str) -> Result<()> {
        match self.kind {
            Kind::Text | Kind::RequiredText(_) => {
                self.field.store_text(settings, value.to_string());
                Ok(())
            }
            Kind::RequiredPath(_) => {
                self.field.store_path(settings, PathBuf::from(value));
                Ok(())
            }
            Kind::Flag => {
                let flag = parse_flag(self.var, value)?;
                self.field.store_flag(settings, flag);
                Ok(())
            }
            Kind::Format => {
                let format = value
                    .parse::<OutputFormat>()
                    .map_err(|error| invalid(self.var, &error.to_string()))?;
                self.field.store_format(settings, format);
                Ok(())
            }
            Kind::List => {
                let list = parse_env_excludes(self.var, value)?;
                self.field.store_list(settings, list);
                Ok(())
            }
            Kind::Count => {
                let count = parse_count(self.var, value)?;
                self.field.store_count(settings, count);
                Ok(())
            }
            Kind::Language => {
                let language = value
                    .parse::<Language>()
                    .map_err(|error| invalid(self.var, &error.to_string()))?;
                self.field.store_language(settings, language);
                Ok(())
            }
        }
    }

    /// Apply a configuration value to the entry's field.
    ///
    /// The configuration file speaks JSON; the caller has already skipped
    /// the `null` that means the key exists but did not speak, so
    /// everything arriving here is a value to check and store. `base` is
    /// the folder the file lives in: a relative `out` is resolved against
    /// it right here, so the merge sees the same kind of value a command
    /// line `--out` carries.
    pub(crate) fn apply_config(
        &self,
        settings: &mut Settings,
        value: Value,
        base: &Path,
    ) -> Result<()> {
        let key = self.field.name();
        match self.kind {
            Kind::Text => {
                let Value::String(text) = value else {
                    return Err(wrong_type(key, "a string"));
                };
                self.field.store_text(settings, text);
            }
            Kind::RequiredText(noun) => {
                let Value::String(text) = value else {
                    return Err(wrong_type(key, "a string"));
                };
                if text.trim().is_empty() {
                    return Err(empty_value(key, noun));
                }
                self.field.store_text(settings, text);
            }
            Kind::RequiredPath(noun) => {
                let Value::String(text) = value else {
                    return Err(wrong_type(key, "a string"));
                };
                if text.trim().is_empty() {
                    return Err(empty_value(key, noun));
                }
                self.field.store_path(settings, base.join(text));
            }
            Kind::Flag => {
                let Value::Bool(flag) = value else {
                    return Err(wrong_type(key, "a boolean"));
                };
                self.field.store_flag(settings, flag);
            }
            Kind::Format => {
                let Value::String(text) = value else {
                    return Err(wrong_type(key, "a string"));
                };
                self.field
                    .store_format(settings, text.parse::<OutputFormat>()?);
            }
            Kind::List => {
                let Value::Array(entries) = value else {
                    return Err(wrong_type(key, "an array of strings"));
                };
                let mut list = Vec::with_capacity(entries.len());
                for entry in entries {
                    let Value::String(raw) = entry else {
                        return Err(wrong_entry_type(key));
                    };
                    list.push(raw);
                }
                let list = normalize_excludes(&list)?;
                self.field.store_list(settings, list);
            }
            Kind::Count => {
                let Value::Number(number) = value else {
                    return Err(wrong_type(key, "a number"));
                };
                let count = number
                    .as_u64()
                    .filter(|count| *count <= u32::MAX as u64)
                    .ok_or_else(|| wrong_type(key, "a positive integer"))?;
                self.field.store_count(settings, count as u32);
            }
            Kind::Language => {
                let Value::String(text) = value else {
                    return Err(wrong_type(key, "a string"));
                };
                self.field
                    .store_language(settings, text.parse::<Language>()?);
            }
        }
        Ok(())
    }
}

/// The output directory setting.
pub(crate) const OUT: SettingSpec = SettingSpec {
    field: Field::Out,
    var: "WIKICC_OUT",
    kind: Kind::RequiredPath("directory path"),
};

/// The output artifact format setting.
pub(crate) const FORMAT: SettingSpec = SettingSpec {
    field: Field::Format,
    var: "WIKICC_FORMAT",
    kind: Kind::Format,
};

/// The site title setting.
pub(crate) const TITLE: SettingSpec = SettingSpec {
    field: Field::Title,
    var: "WIKICC_TITLE",
    kind: Kind::Text,
};

/// The strict gate setting.
pub(crate) const STRICT: SettingSpec = SettingSpec {
    field: Field::Strict,
    var: "WIKICC_STRICT",
    kind: Kind::Flag,
};

/// The opening document setting.
pub(crate) const HOME: SettingSpec = SettingSpec {
    field: Field::Home,
    var: "WIKICC_HOME",
    kind: Kind::RequiredText("string"),
};

/// The exclusion list setting.
pub(crate) const EXCLUDE: SettingSpec = SettingSpec {
    field: Field::Exclude,
    var: "WIKICC_EXCLUDE",
    kind: Kind::List,
};

/// The favicon setting.
pub(crate) const FAVICON: SettingSpec = SettingSpec {
    field: Field::Favicon,
    var: "WIKICC_FAVICON",
    kind: Kind::RequiredText("file path"),
};

/// The global sealing password setting.
pub(crate) const PASSWORD: SettingSpec = SettingSpec {
    field: Field::Password,
    var: "WIKICC_PASSWORD",
    kind: Kind::RequiredText("string"),
};

/// The worker-thread count setting.
pub(crate) const JOBS: SettingSpec = SettingSpec {
    field: Field::Jobs,
    var: "WIKICC_JOBS",
    kind: Kind::Count,
};

/// The reader interface language setting.
pub(crate) const LANGUAGE: SettingSpec = SettingSpec {
    field: Field::Language,
    var: "WIKICC_LANGUAGE",
    kind: Kind::Language,
};

/// Every setting this version knows, in the order the [`Settings`] struct
/// declares them.
pub(crate) const SETTINGS: [SettingSpec; 10] = [
    OUT, FORMAT, TITLE, STRICT, HOME, EXCLUDE, FAVICON, PASSWORD, JOBS, LANGUAGE,
];

/// Parse a boolean spelled `true`, `false`, `1` or `0`, in any letter case.
///
/// The environment's only boolean vocabulary; the configuration file speaks
/// JSON booleans and needs no spelling table.
fn parse_flag(var: &str, value: &str) -> Result<bool> {
    match value.to_ascii_lowercase().as_str() {
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        _ => Err(invalid(var, "must be 'true', 'false', '1' or '0'")),
    }
}

/// Parse a worker-thread count: a decimal integer of at least 1.
fn parse_count(var: &str, value: &str) -> Result<u32> {
    let parsed = value
        .parse::<u32>()
        .map_err(|_| invalid(var, "must be a positive integer"))?;
    if parsed == 0 {
        return Err(invalid(var, "must be at least 1"));
    }
    Ok(parsed)
}

/// Split an environment exclusion value on commas; an empty entry is a hard
/// error.
///
/// The entries are kept verbatim — whitespace included: the normalization
/// and the escape guards both other sources share run later, in
/// [`crate::options::Options::resolve`], on whichever list wins.
fn parse_env_excludes(var: &str, value: &str) -> Result<Vec<String>> {
    let mut list = Vec::new();
    for entry in value.split(',') {
        if entry.trim().is_empty() {
            return Err(invalid(
                var,
                "entries must be non-empty, comma-separated directory paths",
            ));
        }
        list.push(entry.to_string());
    }
    Ok(list)
}

/// An [`Error::InvalidInput`] that names the offending variable.
fn invalid(var: &str, reason: &str) -> Error {
    Error::InvalidInput(format!("environment variable '{var}': {reason}"))
}

/// An [`Error::InvalidInput`] for a configuration value of the wrong type.
fn wrong_type(key: &str, what: &str) -> Error {
    Error::InvalidInput(format!("'{key}' must be {what}"))
}

/// An [`Error::InvalidInput`] for a configuration value that names nothing.
fn empty_value(key: &str, noun: &str) -> Error {
    Error::InvalidInput(format!("'{key}' must be a non-empty {noun}"))
}

/// An [`Error::InvalidInput`] for a configuration list entry of the wrong
/// type.
fn wrong_entry_type(key: &str) -> Error {
    Error::InvalidInput(format!("'{key}' entries must be strings"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config;
    use crate::env::settings_from;
    use crate::options::{Options, Request};
    use clap::CommandFactory as _;

    #[test]
    fn every_entry_is_reachable_under_its_own_names() {
        for spec in SETTINGS.iter() {
            // The variable is the upper-cased field name behind the shared
            // prefix: a misspelled literal fails this line, not a build.
            assert_eq!(
                spec.var,
                format!("WIKICC_{}", spec.field.name().to_ascii_uppercase()),
                "{} names its field",
                spec.field.name(),
            );

            // Both lookups find exactly this entry.
            assert_eq!(
                SettingSpec::by_var(spec.var).map(|found| found.field),
                Some(spec.field)
            );
            assert_eq!(
                SettingSpec::by_key(spec.field.name()).map(|found| found.field),
                Some(spec.field)
            );
        }

        // And no entry hides another: every name is unique.
        let mut names: Vec<&str> = SETTINGS.iter().map(|spec| spec.field.name()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(
            names.len(),
            SETTINGS.len(),
            "a duplicated field name shadows an entry"
        );

        let mut vars: Vec<&str> = SETTINGS.iter().map(|spec| spec.var).collect();
        vars.sort_unstable();
        vars.dedup();
        assert_eq!(
            vars.len(),
            SETTINGS.len(),
            "a duplicated variable name shadows an entry"
        );
    }

    #[test]
    fn the_spec_names_exactly_the_derived_flags() {
        // The command derives from the `Settings` struct, so the spec
        // naming exactly its flags proves all three surfaces agree: the
        // struct speaks for the command line, the spec for the variables
        // and the configuration keys.
        let automatic = ["help", "version"];
        let command = Settings::command();
        let mut flags: Vec<&str> = command
            .get_arguments()
            .filter_map(|argument| argument.get_long())
            .filter(|long| !automatic.contains(long))
            .collect();
        flags.sort_unstable();

        let mut fields: Vec<&str> = SETTINGS.iter().map(|spec| spec.field.name()).collect();
        fields.sort_unstable();

        assert_eq!(
            fields, flags,
            "the spec and the command must name the same settings"
        );
    }

    /// The test value each reader is fed for one setting, in the shape the
    /// reader hands over: the raw variable value and the JSON literal.
    fn sample(field: Field) -> (&'static str, &'static str) {
        match field {
            Field::Out => ("build", "\"site/build\""),
            Field::Format => ("pages", "\"pages\""),
            Field::Title => ("Handbook", "\"Handbook\""),
            Field::Strict => ("true", "true"),
            Field::Home => ("intro.md", "\"intro.md\""),
            Field::Exclude => ("drafts,archive/old", r#"["drafts", "archive/old"]"#),
            Field::Favicon => ("assets/icon.png", "\"assets/icon.png\""),
            Field::Password => ("global secret", "\"global secret\""),
            Field::Jobs => ("4", "4"),
            Field::Language => ("zh", "\"zh\""),
        }
    }

    /// The options one build request merges to, with the walked settings in
    /// the named source slot and the other two sources silent.
    fn resolve_as(request: &Request, env: &Settings, file: &Settings) -> Options {
        Options::resolve(request, env, file).expect("the walked settings resolve")
    }

    /// Assert the merged options carry the walked setting; `from_config`
    /// says which reader fed the merge, which only `out` can see (the
    /// configuration resolves a relative path against its own folder).
    fn check(field: Field, options: &Options, from_config: bool) {
        match field {
            Field::Out => {
                let expected = if from_config {
                    Path::new("input").join("site/build")
                } else {
                    PathBuf::from("build")
                };
                assert_eq!(options.out, expected);
            }
            Field::Format => assert_eq!(options.format, OutputFormat::Pages),
            Field::Title => assert_eq!(options.title, "Handbook"),
            Field::Strict => assert!(options.strict),
            Field::Home => assert_eq!(options.home.as_deref(), Some("intro.md")),
            Field::Exclude => assert_eq!(options.exclude, ["drafts", "archive/old"]),
            Field::Favicon => assert_eq!(options.favicon.as_deref(), Some("assets/icon.png")),
            Field::Password => assert_eq!(options.password.as_deref(), Some("global secret")),
            Field::Jobs => assert_eq!(options.jobs, Some(4)),
            Field::Language => assert_eq!(options.language, Some(Language::Zh)),
        }
    }

    #[test]
    fn every_entry_reaches_the_merged_options_from_both_readers() {
        let request = Request {
            input: PathBuf::from("input"),
            settings: Settings::default(),
            force: false,
            quiet: false,
        };

        for spec in SETTINGS.iter() {
            let (var_value, json_value) = sample(spec.field);

            // From its variable, through the environment reader into the
            // merge.
            let env = settings_from([(spec.var, var_value)]).expect("the variable parses");
            check(
                spec.field,
                &resolve_as(&request, &env, &Settings::default()),
                false,
            );

            // From its key, through the configuration reader into the
            // merge.
            let text = format!("{{\"{}\": {}}}", spec.field.name(), json_value);
            let file = config::parse(
                text.as_bytes(),
                Path::new(".wikicc.json"),
                Path::new("input"),
            )
            .expect("the key parses");
            check(
                spec.field,
                &resolve_as(&request, &Settings::default(), &file.settings),
                true,
            );
        }
    }
}
