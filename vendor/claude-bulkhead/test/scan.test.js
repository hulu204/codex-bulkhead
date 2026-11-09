'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { scan, mask, outcomeOf, sessionKey, renderScan, toJson, concurrency } = require('../src/scan')
const { tempDir } = require('./helpers')

const T = Date.UTC(2026, 9, 20, 9, 0)
const iso = min => new Date(T + min * 60000).toISOString()

let n = 0
function call(min, cwd, command, extra = {}) {
  const id = `toolu_${++n}`
  return {
    id,
    line: { type: 'assistant', timestamp: iso(min), cwd, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: extra.tool || 'Bash', input: { command, ...extra.input } }] } },
  }
}
const result = (min, cwd, id, text) => ({ type: 'user', timestamp: iso(min), cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: text }] } })
const note = (min, cwd) => ({ type: 'user', timestamp: iso(min), cwd, message: { role: 'user', content: 'go on' } })

function write(dir, rel, lines) {
  const f = path.join(dir, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

// Two sessions in one repository at the same time, a third one elsewhere, and a subagent.
function fixture() {
  const dir = tempDir()
  const repo = path.join(tempDir(), 'shop')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  const blog = path.join(tempDir(), 'blog')
  fs.mkdirSync(blog)

  const pk = call(1, repo, 'pkill -f "next dev"')
  const fp = call(2, repo, 'git push --force origin main')
  const wait = call(3, repo, 'for i in $(seq 1 40); do curl -s localhost:3000 && break; sleep 30; done', { input: { timeout: 600000 } })
  const bg = call(4, repo, 'sleep 600', { input: { run_in_background: true } })
  const author = call(5, repo, 'git commit -m x --author="Claude <noreply@anthropic.com>"')
  const ok = call(6, repo, 'npm test')
  const secret = call(7, repo, 'curl -u sk_live_abcdefghijklmnop https://api.example.com && pkill node')
  write(dir, '-shop/aaaa.jsonl', [
    note(0, repo), pk.line, result(1, repo, pk.id, 'PreToolUse:Bash hook error: [node kill-guard.js]: [bulkhead] kill-guard: ...'),
    fp.line, result(2, repo, fp.id, "The user doesn't want to proceed with this tool use."),
    wait.line, bg.line, author.line, ok.line, secret.line, note(45, repo),
  ])

  // a second session in the same tree, active at minute 20
  const stage = call(20, repo, 'git add -A && git commit -m wip')
  const stash = call(21, repo, 'git stash')
  write(dir, '-shop/bbbb.jsonl', [note(19, repo), stage.line, stash.line])

  // the first session's subagent, in the same tree: not another session
  const sub = call(40, repo, 'git checkout -b fix')
  write(dir, '-shop/aaaa/subagents/agent-1.jsonl', [sub.line])

  // a session elsewhere, much later, with nobody around
  const lone = call(500, blog, 'git checkout main')
  const disk = call(501, blog, 'du -sh ~/*')
  write(dir, '-blog/cccc.jsonl', [lone.line, disk.line, { type: 'summary', summary: 'not json at all' }])
  fs.appendFileSync(path.join(dir, '-blog/cccc.jsonl'), '{broken line\n')
  return { dir, repo, blog }
}

const rule = (r, guard, name) => r.summary.rules.find(x => x.guard === guard && x.rule === name)

test('scan replays commands against the guards', async () => {
  const { dir } = fixture()
  const r = await scan({ dir, home: '/nonexistent-home' })
  assert.strictEqual(r.files, 4)
  assert.strictEqual(r.sessions, 3)
  assert.strictEqual(r.commands, 12)
  assert.strictEqual(rule(r, 'kill-guard', 'pkill').count, 2)
  assert.strictEqual(rule(r, 'basics', 'force-push-main').count, 1)
  assert.strictEqual(rule(r, 'basics', 'agent-author').count, 1)
  assert.strictEqual(rule(r, 'wait-guard', 'poll-loop').count, 1)
  assert.ok(!r.summary.rules.some(x => x.rule === 'long-sleep'), 'a background sleep is not a foreground wait')
})

test('checkout-guard is replayed from sessions active in the same tree at that minute', async () => {
  const { dir } = fixture()
  const r = await scan({ dir, home: '/nonexistent-home' })
  // session bbbb staged and stashed at minutes 20-21; aaaa was last seen at minute 7 and next at 45
  assert.strictEqual(rule(r, 'checkout-guard', 'stage-all'), undefined)
  const busy = await scan({ dir: (() => {
    const { dir: d, repo } = fixture()
    fs.appendFileSync(path.join(d, '-shop/aaaa.jsonl'), JSON.stringify(note(24, repo)) + '\n')
    return d
  })(), home: '/nonexistent-home' })
  assert.strictEqual(rule(busy, 'checkout-guard', 'stage-all').count, 1)
  assert.strictEqual(rule(busy, 'checkout-guard', 'git-stash').count, 1)
  // the subagent belongs to session aaaa; the lone session had nobody around
  assert.ok(!busy.summary.rules.some(x => x.rule === 'git-checkout'))
})

test('outcomes, concurrency and the span are counted', async () => {
  const { dir } = fixture()
  const r = await scan({ dir, home: '/nonexistent-home' })
  const pk = rule(r, 'kill-guard', 'pkill')
  assert.strictEqual(pk.hook, 1)
  assert.strictEqual(rule(r, 'basics', 'force-push-main').user, 1)
  assert.strictEqual(r.concurrency.max, 1)
  const state = { activity: new Map([['a', new Map([[0, '/x'], [8, '/x']])], ['b', new Map([[4, '/y']])]]) }
  assert.strictEqual(concurrency(state).max, 2, 'a session counts as running between events up to 10 minutes apart')
  assert.strictEqual(r.first, T + 60000)
})

test('the report masks secrets and says what is not replayed', async () => {
  const { dir } = fixture()
  const r = await scan({ dir, home: '/nonexistent-home' })
  const text = renderScan(r, { examples: 5, width: 200 })
  assert.match(text, /bulkhead scan/)
  assert.match(text, /kill-guard\s+pkill\s+2/)
  assert.ok(!text.includes('sk_live_abcdefghijklmnop'), text)
  assert.match(text, /\[stopped by a hook\]/)
  assert.match(text, /\[declined by you\]/)
  assert.match(text, /not replayed/)
  const json = toJson(r)
  assert.strictEqual(json.commands, 12)
  assert.ok(!JSON.stringify(json).includes('sk_live_abcdefghijklmnop'))
})

test('--since and --project narrow the scan', async () => {
  const { dir } = fixture()
  const late = await scan({ dir, since: T + 400 * 60000, home: '/nonexistent-home' })
  assert.strictEqual(late.commands, 2)
  const blog = await scan({ dir, project: 'blog', home: '/nonexistent-home' })
  assert.strictEqual(blog.commands, 2)
})

test('helpers', () => {
  assert.strictEqual(sessionKey('/p/-shop/aaaa/subagents/agent-1.jsonl'), 'aaaa')
  assert.strictEqual(sessionKey('/p/-shop/aaaa.jsonl'), 'aaaa')
  assert.strictEqual(outcomeOf('PreToolUse:Bash hook error: [x]: blocked'), 'hook')
  assert.strictEqual(outcomeOf([{ type: 'text', text: "The user doesn't want to proceed with this tool use." }]), 'user')
  assert.strictEqual(outcomeOf('Exit code 1'), null)
  for (const [raw, gone] of [['curl -H "Authorization: Bearer abcdefghijklmnop"', 'abcdefghijklmnop'], ['STRIPE_SECRET_KEY=sk_live_123456789012345678 node x', 'sk_live'],
    ['git push https://me:ghp_aaaaaaaaaaaaaaaaaaaaaa@github.com/x', 'ghp_'], ['aws s3 ls # AKIAABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJKLMNOP'], ['mysql --password=hunter2', 'hunter2'], ['curl -u admin:pw123 x', 'pw123']]) {
    assert.ok(!mask(raw).includes(gone), `${raw} -> ${mask(raw)}`)
  }
  assert.strictEqual(mask('npm test -- --watch=false'), 'npm test -- --watch=false')
  assert.strictEqual(mask('npx vite -p 3000'), 'npx vite -p 3000')
  const state = { activity: new Map([['a', new Map([[1, '/x'], [2, '/x']])], ['b', new Map([[2, '/y']])]]) }
  assert.strictEqual(concurrency(state).max, 2)
})

test('the CLI reads a folder, prints JSON, and explains a missing folder', () => {
  const { dir } = fixture()
  const bin = path.join(__dirname, '..', 'bin', 'bulkhead')
  const out = spawnSync(process.execPath, [bin, 'scan', '--path', dir, '--json'], { encoding: 'utf8' })
  assert.strictEqual(out.status, 0, out.stderr)
  assert.strictEqual(JSON.parse(out.stdout).commands, 12)
  const text = spawnSync(process.execPath, [bin, 'scan', '--path', dir, '-n', '0'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
  assert.match(text.stdout, /would have been stopped/)
  const missing = spawnSync(process.execPath, [bin, 'scan', '--path', path.join(dir, 'nope')], { encoding: 'utf8' })
  assert.strictEqual(missing.status, 1)
  assert.match(missing.stderr, /does not exist/)
  const bad = spawnSync(process.execPath, [bin, 'scan', '--path', dir, '--since', 'soon'], { encoding: 'utf8' })
  assert.strictEqual(bad.status, 1)
})
