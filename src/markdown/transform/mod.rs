//! Own-layer transforms over the parsed tree.
//!
//! Each submodule is one pass, and the passes run in the order the engine
//! decision fixed: the citation fold first (it owns the `[[` opening),
//! wikilinks and embeds on the remainder, then the inline sugar, and the
//! callout container transform last.

pub(crate) mod callout;
pub(crate) mod fold;
pub(crate) mod inline;
pub(crate) mod wikilink;
