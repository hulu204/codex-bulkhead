---
name: bulkhead
description: Coordinate concurrent Codex work without disrupting other local sessions.
---

# Codex Bulkhead

Use the local coordinator when multiple Codex sessions or subagents share one machine.

- Work in a separate Git worktree for changes that could alter a shared checkout.
- Stop a process only by a PID that belongs to the current task; never kill a shared program by name.
- Keep disk scans scoped to a known directory.
- When a guard blocks a command, use the safe command it describes. Do not disable the hook merely to repeat the blocked command.

The hooks are a local coordination aid. They intentionally fail open if their registry is missing or malformed, and they do not terminate orphaned processes.
