# Wikicc Fixture Site

A small site for the site-assembly tests. It is `--strict` clean: every
relative link resolves and every referenced asset exists.

## Overview

Read the [introduction](guide/intro.md) first, then the
[getting started section](guide/intro.md#getting-started) again — the link
graph must collapse both references into a single edge.

An [external link](https://example.com) and a [local anchor](#overview) never
become edges.

![Logo](assets/logo.svg)

| Document | Links |
| -------- | ----- |
| intro    | 2     |
| setup    | 0     |

Inline `code` is searchable, and so is the fence below.

```rust
fn main() {}
```
