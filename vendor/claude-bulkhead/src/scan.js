'use strict'
// bulkhead scan: replays the shell commands in your Claude Code transcripts against the guards,
// to show what they would have stopped before you install them, or what they stopped since.
// Read-only: it opens transcripts for reading and writes nothing.

const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')
const { claudeDir } = require('./sessions')
const { setting } = require('./hook')
const { useColor, paint, shortPath, option, fit, table, bytes } = require('./cli-util')
const { parseSince } = require('./log-cli')

const USAGE = `usage: bulkhead scan [--since 30d|DATE] [--path DIR|FILE] [--project TEXT] [-n N] [--json]

Replays the shell commands in your Claude Code transcripts against bulkhead's guards and shows
what they would have stopped. Read-only. Nothing leaves this machine.
  --since SPAN     only commands newer than SPAN: 24h, 7d, 2w, or a date such as 2026-10-01
  --path P         transcripts to read (default: ~/.claude/projects)
  --project TEXT   only sessions whose folder contains TEXT
  -n N             examples to show per rule (default 3, 0 for none)
  --json           machine-readable output`

// Minutes on either side of a command in which another session counts as active.
const ACTIVE_WINDOW_MIN = 10

// ---------------------------------------------------------------------------------------------
// Reading transcripts

// Every .jsonl under dir (subagent transcripts included), or the file itself.
function findTranscripts(p, { since = null } = {}) {
  const out = []
  let st
  try { st = fs.statSync(p) } catch { return out }
  if (st.isFile()) return /\.jsonl$/.test(p) ? [{ file: p, size: st.size }] : []
  const walk = (dir, depth) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const f = path.join(dir, e.name)
      if (e.isDirectory() && depth < 4) walk(f, depth + 1)
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const s = fs.statSync(f)
          if (since == null || s.mtimeMs >= since) out.push({ file: f, size: s.size })
        } catch {}
      }
    }
  }
  walk(p, 0)
  return out
}

// A subagent writes <session>/subagents/agent-*.jsonl; it belongs to the parent session.
function sessionKey(file) {
  const parts = file.split(/[\\/]/)
  const i = parts.lastIndexOf('subagents')
  if (i > 0) return parts[i - 1]
  return path.basename(file, '.jsonl')
}

const TS = '"timestamp":"'
function timestampOf(line) {
  const i = line.lastIndexOf(TS)
  if (i < 0) return NaN
  return Date.parse(line.slice(i + TS.length, line.indexOf('"', i + TS.length)))
}

// What became of a tool call that came back as an error: a PreToolUse hook stopped it, or the
// person declined it in the permission prompt.
function outcomeOf(text) {
  const s = typeof text === 'string' ? text : Array.isArray(text) ? text.map(t => (t && t.text) || '').join('\n') : ''
  if (/PreToolUse:\S* hook error|hook (?:blocked|denied)|\[bulkhead\]/i.test(s)) return 'hook'
  if (/doesn't want to proceed|user (?:rejected|declined|denied)|permission (?:for this tool use )?(?:was )?denied/i.test(s)) return 'user'
  return null
}

// Reads one transcript into `state`: commands, outcomes, and the minutes each session was active.
async function readTranscript(file, state, { since = null } = {}) {
  const session = sessionKey(file)
  const stream = fs.createReadStream(file, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let lastCwd = null
  for await (const line of rl) {
    state.lines++
    const ts = timestampOf(line)
    if (Number.isFinite(ts) && (since == null || ts >= since)) {
      const minutes = state.activity.get(session) || new Map()
      const m = Math.floor(ts / 60000)
      if (!minutes.has(m)) minutes.set(m, lastCwd)
      state.activity.set(session, minutes)
    }
    const call = line.includes('"tool_use"') && (line.includes('"Bash"') || line.includes('"PowerShell"'))
    const result = line.includes('"tool_result"') && line.includes('"is_error":true')
    const hasCwd = line.includes('"cwd":"')
    if (!call && !result && !hasCwd) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    if (obj.cwd) {
      lastCwd = obj.cwd
      const minutes = state.activity.get(session)
      if (minutes && Number.isFinite(ts)) minutes.set(Math.floor(ts / 60000), obj.cwd)
    }
    const items = obj.message && Array.isArray(obj.message.content) ? obj.message.content : []
    if (call && obj.type === 'assistant') {
      if (since != null && !(ts >= since)) continue
      for (const it of items) {
        if (!it || it.type !== 'tool_use' || (it.name !== 'Bash' && it.name !== 'PowerShell')) continue
        const input = it.input || {}
        if (typeof input.command !== 'string' || !input.command) continue
        state.commands.push({
          id: it.id || null,
          session,
          file,
          tool: it.name,
          command: input.command,
          background: input.run_in_background === true || input.run_in_background === 'true',
          timeout: input.timeout,
          cwd: obj.cwd || lastCwd,
          ts,
        })
      }
    }
    if (result && obj.type === 'user') {
      for (const it of items) {
        if (!it || it.type !== 'tool_result' || !it.is_error || !it.tool_use_id) continue
        const o = outcomeOf(it.content)
        if (o) state.outcomes.set(it.tool_use_id, o)
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Replaying

// The folder git would call the top of the tree, found by looking for .git on disk. A folder
// that no longer exists is its own tree.
const treeCache = new Map()
function treeRoot(cwd) {
  if (!cwd) return null
  // a transcript copied from another OS: C:\Users\... on macOS is not a path here
  if (process.platform !== 'win32' && /^[a-z]:[\\/]/i.test(cwd)) return cwd.replace(/\\/g, '/')
  if (treeCache.has(cwd)) return treeCache.get(cwd)
  let dir = path.resolve(cwd)
  let found = null
  for (let i = 0; i < 40; i++) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) { found = dir; break }
    } catch {}
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  const root = found || path.resolve(cwd)
  treeCache.set(cwd, root)
  return root
}

// git as the guards would have seen it: the tree is known, the branch and status are not, so a
// question about them throws and the guard lets the command through. One exception: for
// git add -A and git commit -a (status --porcelain with no other option), checkout-guard asks
// only after another session was active in the same tree, and that session was most likely
// editing files there. A dirty pull is not assumed.
function replayGit({ assumeEdits = false } = {}) {
  return (args, cwd) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return treeRoot(cwd)
    if (assumeEdits && args[0] === 'status' && args.length === 2) return ' M (another session was active here)'
    throw new Error('not replayed')
  }
}

// Other sessions active within the window around `ts`, as the session files checkout-guard reads.
function activeOthers(state, session, ts) {
  const files = new Map()
  if (!Number.isFinite(ts)) return files
  const m = Math.floor(ts / 60000)
  let pid = 1
  for (const [other, minutes] of state.activity) {
    if (other === session) continue
    let cwd = null
    for (let k = m - ACTIVE_WINDOW_MIN; k <= m + ACTIVE_WINDOW_MIN && !cwd; k++) {
      if (minutes.has(k)) cwd = minutes.get(k)
    }
    if (cwd) files.set(pid++, { cwd, sessionId: other, startedAt: null })
  }
  return files
}

// Every guard rule that would have stopped this command, as [{ guard, rule }].
function replay(cmd, state, { home = os.homedir(), platform = process.platform } = {}) {
  const hits = []
  const mode = cmd.tool === 'PowerShell' ? 'ps' : 'sh'
  const text = cmd.command
  const cwd = cmd.cwd || home
  const add = (guard, rule) => { if (!hits.some(h => h.guard === guard && h.rule === rule)) hits.push({ guard, rule }) }
  const tryRun = fn => { try { fn() } catch {} }

  tryRun(() => {
    const hit = require('./kill-guard').classify(text, { allowNames: setting('killGuard.allowNames', []), extraSharedNames: setting('killGuard.extraSharedNames', []) }, mode)
    if (hit) add('kill-guard', hit.rule)
  })
  tryRun(() => {
    if (cmd.background) return
    const v = require('./wait-guard').judge(text, cmd.timeout, setting('waitGuard.limitSeconds', 180), mode)
    if (v) add('wait-guard', v.rule)
  })
  tryRun(() => {
    if (require('./memory-guard').touchesSlotFiles(text)) add('memory-guard', 'slot-files')
  })
  tryRun(() => {
    const hit = require('./disk-guard').check(text, { home, mode })
    if (hit) add('disk-guard', hit.rule)
  })
  tryRun(() => {
    const basics = require('./basics')
    const why = basics.check(text, { cwd, home, platform, run: replayGit(), mode })
    if (why) add('basics', basics.ruleOf(why))
  })
  tryRun(() => {
    const others = activeOthers(state, cmd.session, cmd.ts)
    if (!others.size) return
    const hit = require('./checkout-guard').classify(text, {
      cwd, sessionId: cmd.session, files: () => others, isAlive: () => true, run: replayGit({ assumeEdits: true }), platform, mode,
      home, links: () => [], removeRule: () => true, stageRule: () => true,
    })
    if (hit && hit.rule !== 'worktree-force-links') add('checkout-guard', hit.rule)
  })
  return hits
}

// The most sessions running at once, and on how many days two or more overlapped. A session
// counts as running between two of its events when they are at most ACTIVE_WINDOW_MIN apart.
function concurrency(state) {
  const perMinute = new Map()
  for (const minutes of state.activity.values()) {
    const sorted = [...minutes.keys()].sort((a, b) => a - b)
    for (let i = 0; i < sorted.length; i++) {
      const next = sorted[i + 1]
      const end = next != null && next - sorted[i] <= ACTIVE_WINDOW_MIN ? next - 1 : sorted[i]
      for (let m = sorted[i]; m <= end; m++) perMinute.set(m, (perMinute.get(m) || 0) + 1)
    }
  }
  let max = 0
  let at = null
  const days = new Set()
  for (const [m, n] of perMinute) {
    if (n > max || (n === max && at != null && m > at)) { max = n; at = m }
    if (n >= 2) days.add(new Date(m * 60000).toDateString())
  }
  return { max, at: at == null ? null : new Date(at * 60000).toISOString(), overlapDays: days.size }
}

// ---------------------------------------------------------------------------------------------
// Masking and summary

// Secret-looking values are cut out of the examples before anything is printed. Every pattern
// is linear in the length of the command: a transcript can hold a command of megabytes.
const SECRET_NAME = /PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY/i
const SECRETS = [
  [/(^|\s)(-u|--user|--password|--token|--api-key|--secret)(\s+|=)(['"]?)[^\s'"]+\4/gi, '$1$2$3***'],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  // NAME=value where the name says it is a secret; the name is matched once, then tested
  [/\b([A-Za-z_][A-Za-z0-9_]*)=(['"]?)([^\s'"]+)\2/g, (m, name, q) => (SECRET_NAME.test(name) ? `${name}=${q}***${q}` : m)],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, '***'],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}\b/g, '***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '***'],
  [/\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g, '***'],
  [/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1***@'],
]
function mask(s) {
  let out = String(s)
  for (const [re, to] of SECRETS) out = out.replace(re, to)
  return out
}

function summarize(state, hitsByCommand) {
  const rules = new Map()
  const sessions = new Set()
  const projects = new Map()
  let commandsHit = 0
  for (const { cmd, hits } of hitsByCommand) {
    if (!hits.length) continue
    commandsHit++
    sessions.add(cmd.session)
    const proj = treeRoot(cmd.cwd) || '?'
    projects.set(proj, (projects.get(proj) || 0) + 1)
    const outcome = (cmd.id && state.outcomes.get(cmd.id)) || null
    for (const h of hits) {
      const k = `${h.guard}\u0000${h.rule}`
      const r = rules.get(k) || { guard: h.guard, rule: h.rule, count: 0, sessions: new Set(), hook: 0, user: 0, last: null, examples: [] }
      r.count++
      r.sessions.add(cmd.session)
      if (outcome === 'hook') r.hook++
      if (outcome === 'user') r.user++
      if (Number.isFinite(cmd.ts) && (!r.last || cmd.ts > r.last)) r.last = cmd.ts
      r.examples.push({ command: mask(cmd.command), cwd: cmd.cwd, ts: cmd.ts, outcome })
      rules.set(k, r)
    }
  }
  const list = [...rules.values()].map(r => ({
    ...r,
    sessions: r.sessions.size,
    // newest first, one example per distinct command
    examples: dedupe(r.examples.sort((a, b) => (b.ts || 0) - (a.ts || 0))),
  })).sort((a, b) => b.count - a.count || a.guard.localeCompare(b.guard) || a.rule.localeCompare(b.rule))
  return {
    commandsHit,
    sessionsHit: sessions.size,
    rules: list,
    projects: [...projects].map(([project, count]) => ({ project, count })).sort((a, b) => b.count - a.count),
  }
}

function dedupe(examples) {
  const seen = new Set()
  return examples.filter(e => {
    const k = e.command.replace(/\s+/g, ' ').trim()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// ---------------------------------------------------------------------------------------------
// Output

const pad2 = n => String(n).padStart(2, '0')
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')
const day = ms => { const d = new Date(ms); return `${MONTHS[d.getMonth()]} ${pad2(d.getDate())}` }
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`

// What each guard protects, said once under its first rule.
const RULE_NOTES = {
  'kill-guard': 'kills by program name take down every session\'s servers',
  'wait-guard': 'foreground waits hold the session and expire the prompt cache',
  'memory-guard': 'hand-edited slot files leave a slot held by nobody',
  'disk-guard': 'whole-disk and parallel scans stall every session\'s I/O',
  basics: 'mistakes that cannot be undone',
  'checkout-guard': 'another session was active in the same tree at that minute',
}

function renderScan(r, { color = false, home = os.homedir(), examples = 3, width = 120 } = {}) {
  const out = []
  const b = s => paint(color, 'bold', s)
  out.push(`${b('bulkhead scan')}  replaying your Claude Code sessions against the guards`)
  out.push(`  read     ${plural(r.files, 'transcript')} (${bytes(r.bytes)}), ${plural(r.sessions, 'session')}, ${plural(r.commands, 'shell command')} in ${r.seconds.toFixed(1)}s`)
  if (r.first) out.push(`  span     ${day(r.first)} .. ${day(r.last)}${r.sinceLabel ? `  (since ${r.sinceLabel})` : ''}`)
  if (r.concurrency.max >= 2) {
    out.push(`  overlap  up to ${b(r.concurrency.max)} sessions running at once (${day(Date.parse(r.concurrency.at))}), ` +
      `${plural(r.concurrency.overlapDays, 'day')} with two or more at once`)
  }
  out.push('')
  if (!r.summary.rules.length) {
    out.push(r.commands ? 'Nothing in these transcripts would have been stopped.' : 'No shell commands found.')
    return out.join('\n')
  }
  const rows = [['GUARD', 'RULE', 'HITS', 'SESSIONS', 'STOPPED', 'LAST']]
  for (const x of r.summary.rules) {
    const stopped = x.hook + x.user
    rows.push([x.guard, x.rule, String(x.count).padStart(4), String(x.sessions).padStart(8), stopped ? `${stopped}`.padStart(7) : '      -', x.last ? day(x.last) : ''])
  }
  const lines = table(rows)
  out.push(b(lines[0]), ...lines.slice(1))
  if (examples > 0) {
    let lastGuard = null
    for (const x of r.summary.rules) {
      out.push('')
      const note = x.guard !== lastGuard && RULE_NOTES[x.guard] ? paint(color, 'dim', `  ${RULE_NOTES[x.guard]}`) : ''
      lastGuard = x.guard
      out.push(`${paint(color, x.guard === 'checkout-guard' || x.guard === 'kill-guard' ? 'red' : 'yellow', `${x.guard}  ${x.rule}`)}  ${plural(x.count, 'time')} in ${plural(x.sessions, 'session')}${note}`)
      for (const e of x.examples.slice(0, examples)) {
        const tag = e.outcome === 'hook' ? '  [stopped by a hook]' : e.outcome === 'user' ? '  [declined by you]' : ''
        const meta = `${shortPath(e.cwd ? treeRoot(e.cwd) : '?', home)}  ${e.ts ? day(e.ts) : ''}${tag}`
        const room = Math.max(30, width - meta.length - 8)
        out.push(`  $ ${fit(e.command.replace(/\s*\n\s*/g, ' ⏎ '), room)}  ${paint(color, 'gray', meta)}`)
      }
    }
  }
  out.push('')
  const s = r.summary
  const already = s.rules.reduce((n, x) => n + x.hook + x.user, 0)
  out.push(b(`${plural(s.commandsHit, 'command')} in ${plural(s.sessionsHit, 'session')} would have been stopped by bulkhead.`) +
    (already ? ` ${already.toLocaleString('en-US')} of the hits were already stopped by a hook or declined by you.` : ''))
  out.push(paint(color, 'dim', 'A hit means the command had the shape a guard blocks, not that damage was done. port-guard and the low-RAM check depend on'))
  out.push(paint(color, 'dim', 'what was running at that moment and are not replayed. checkout-guard is replayed from which sessions were active in the same folder.'))
  return out.join('\n')
}

function toJson(r) {
  return {
    files: r.files,
    bytes: r.bytes,
    sessions: r.sessions,
    commands: r.commands,
    seconds: Number(r.seconds.toFixed(2)),
    first: r.first ? new Date(r.first).toISOString() : null,
    last: r.last ? new Date(r.last).toISOString() : null,
    concurrency: r.concurrency,
    commandsHit: r.summary.commandsHit,
    sessionsHit: r.summary.sessionsHit,
    rules: r.summary.rules.map(x => ({
      guard: x.guard, rule: x.rule, count: x.count, sessions: x.sessions, stoppedByHook: x.hook, declinedByUser: x.user,
      last: x.last ? new Date(x.last).toISOString() : null,
      examples: x.examples.slice(0, 5).map(e => ({ command: e.command, project: treeRoot(e.cwd) || e.cwd, time: e.ts ? new Date(e.ts).toISOString() : null, outcome: e.outcome })),
    })),
    projects: r.summary.projects,
  }
}

// ---------------------------------------------------------------------------------------------

async function scan({ dir = path.join(claudeDir(), 'projects'), since = null, project = null, home = os.homedir(), platform = process.platform } = {}) {
  const t0 = Date.now()
  const files = findTranscripts(dir, { since })
  const state = { commands: [], outcomes: new Map(), activity: new Map(), lines: 0 }
  for (const f of files) {
    try { await readTranscript(f.file, state, { since }) } catch {}
  }
  let commands = state.commands
  if (project) commands = commands.filter(c => String(c.cwd || '').toLowerCase().includes(project.toLowerCase()))
  const hitsByCommand = commands.map(cmd => ({ cmd, hits: replay(cmd, state, { home, platform }) }))
  const times = commands.map(c => c.ts).filter(Number.isFinite)
  return {
    files: files.length,
    bytes: files.reduce((n, f) => n + f.size, 0),
    sessions: new Set(commands.map(c => c.session)).size,
    commands: commands.length,
    first: times.length ? Math.min(...times) : null,
    last: times.length ? Math.max(...times) : null,
    concurrency: concurrency(state),
    summary: summarize(state, hitsByCommand),
    seconds: (Date.now() - t0) / 1000,
  }
}

async function main(args, { env = process.env, stdout = process.stdout, stderr = process.stderr, now = Date.now() } = {}) {
  if (args.includes('--help') || args.includes('-h')) return stdout.write(USAGE + '\n')
  const sinceArg = option(args, 'since')
  let since = null
  if (typeof sinceArg === 'string' && sinceArg) {
    since = parseSince(sinceArg, now)
    if (!Number.isFinite(since)) {
      stderr.write(`bulkhead scan: cannot read --since ${sinceArg}; use 24h, 7d, 2w or a date like 2026-10-01\n`)
      process.exitCode = 1
      return
    }
  }
  const p = option(args, 'path')
  const dir = typeof p === 'string' ? path.resolve(p.replace(/^~(?=[\\/]|$)/, os.homedir())) : path.join(claudeDir(), 'projects')
  if (!fs.existsSync(dir)) {
    stderr.write(`bulkhead scan: ${shortPath(dir)} does not exist. Claude Code keeps transcripts in ~/.claude/projects; pass another folder with --path.\n`)
    process.exitCode = 1
    return
  }
  const proj = option(args, 'project')
  const nIdx = args.indexOf('-n')
  const n = nIdx >= 0 && Number(args[nIdx + 1]) >= 0 ? Math.floor(Number(args[nIdx + 1])) : 3
  const r = await scan({ dir, since, project: typeof proj === 'string' ? proj : null })
  r.sinceLabel = typeof sinceArg === 'string' ? sinceArg : null
  if (args.includes('--json')) return stdout.write(JSON.stringify(toJson(r), null, 2) + '\n')
  stdout.write(renderScan(r, { color: useColor(stdout, env), examples: n, width: stdout.columns || 120 }) + '\n')
}

module.exports = { main, scan, replay, renderScan, toJson, mask, outcomeOf, sessionKey, findTranscripts, concurrency, USAGE }
