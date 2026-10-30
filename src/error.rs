//! Error type and exit-code contract shared by the library and the binary.

/// Exit code for a successful run (warnings are allowed).
pub const EXIT_SUCCESS: i32 = 0;
/// Exit code for a runtime failure (bad input, I/O error, `--strict` with warnings).
pub const EXIT_FAILURE: i32 = 1;
/// Exit code used by `clap` for usage errors.
pub const EXIT_USAGE: i32 = 2;

/// Errors produced while preparing or running a build.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A filesystem operation failed.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// The arguments or the resolved input/output paths cannot be used.
    #[error("{0}")]
    InvalidInput(String),

    /// Warnings were collected while `--strict` was set.
    #[error("{0}")]
    Warnings(String),

    /// Writing an artifact failed.
    #[error("failed to write output: {0}")]
    Write(String),

    /// The page shell could not be assembled.
    #[error("render error: {0}")]
    Render(String),
}

impl Error {
    /// Process exit code for this error.
    ///
    /// Usage errors (exit code 2) never reach this function: `clap` reports them
    /// before the pipeline starts.
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::Io(_)
            | Self::InvalidInput(_)
            | Self::Warnings(_)
            | Self::Write(_)
            | Self::Render(_) => EXIT_FAILURE,
        }
    }
}

/// Convenience alias for results produced by this crate.
pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_errors_exit_with_failure_code() {
        let errors = [
            Error::Io(std::io::Error::other("boom")),
            Error::InvalidInput("input directory not found: x".to_string()),
            Error::Warnings("2 warnings".to_string()),
            Error::Write("disk full".to_string()),
            Error::Render("template broken".to_string()),
        ];

        for error in errors {
            assert_eq!(error.exit_code(), EXIT_FAILURE);
        }
        assert_eq!(EXIT_SUCCESS, 0);
        assert_eq!(EXIT_USAGE, 2);
    }

    #[test]
    fn messages_are_human_readable() {
        assert_eq!(
            Error::InvalidInput("input directory not found: x".to_string()).to_string(),
            "input directory not found: x"
        );
        assert_eq!(
            Error::Io(std::io::Error::other("boom")).to_string(),
            "io error: boom"
        );
        assert_eq!(
            Error::Write("disk full".to_string()).to_string(),
            "failed to write output: disk full"
        );
        assert_eq!(
            Error::Render("template broken".to_string()).to_string(),
            "render error: template broken"
        );
    }
}
