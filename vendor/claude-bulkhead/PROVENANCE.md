# Upstream provenance

- Source: https://github.com/dooly6276/claude-bulkhead
- Revision: `00cf65ce5e1522b2fe628d2c5bac083c10d1d77a`
- Upstream version: 0.2.0
- License: MIT, Copyright (c) 2026 Myeongseok-Kang; full text in LICENSE here.
- `src/` and `test/` are copied unchanged. Codex adapters live outside this directory.
- The Codex executable imports classifiers and memory helpers only. Upstream remote execution,
  Claude process discovery, CLI entrypoints, and automatic orphan reaping are not exposed.
