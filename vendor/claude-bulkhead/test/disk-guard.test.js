'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { check } = require('../src/disk-guard')
const { runScript } = require('./helpers')

const home = '/Users/dev'
const rule = (cmd, opts = {}) => (check(cmd, { home, ...opts }) || {}).rule || null

test('sizing the whole drive or home folder is blocked', () => {
  for (const cmd of ['du -sh ~', 'du -sh ~/*', 'du -sm ~/', 'sudo du -sh /', 'du -sh /*', 'ncdu /', 'du -sh $HOME', 'du -sh "${HOME}"',
    'dust ~', 'gdu /', 'du -sh /Users', 'du -sh /home', 'du -d 1 -h ~', 'du --max-depth=1 -h /', 'ls -R ~', 'bash -c "du -sh ~"',
    'du -sh /Users/dev', 'cd /tmp && du -sh ~ | sort -h']) {
    assert.strictEqual(rule(cmd), 'disk-wide-scan', cmd)
  }
})

test('find over the whole drive or home without -maxdepth is blocked', () => {
  for (const cmd of ['find / -name foo', 'find ~ -name "*.log"', 'sudo find / -type f -size +1G', 'find -L ~ -name x', 'find $HOME -newer x']) {
    assert.strictEqual(rule(cmd), 'disk-wide-find', cmd)
  }
})

test('scans run in parallel are blocked wherever they point', () => {
  for (const cmd of ['ls ~/dev | xargs -P 10 -I{} du -sm ~/dev/{}', 'find . -maxdepth 1 -type d | xargs --max-procs=8 du -sh',
    'du -sh a & du -sh b & wait', 'du -sh a & du -sh b', 'for d in */; do du -sh "$d" & done; wait',
    'find ~/dev -maxdepth 1 -type d | parallel du -sh']) {
    assert.strictEqual(rule(cmd), 'parallel-disk-scan', cmd)
  }
})

test('everyday disk commands pass', () => {
  for (const cmd of ['du -sh node_modules', 'du -sh ~/Library/Caches', 'du -sh ./dist ./build', 'find . -name x', 'find ~ -maxdepth 2 -name x',
    'find /tmp -name x', 'find ~/dev -name package.json', 'du -sh "$DIR"', 'ls -r ~', 'ls -la ~', 'du -sh a; du -sh b', 'echo du -sh ~',
    'git log | xargs -P 4 echo', 'du --version', 'ls ~/dev | xargs -P 1 du -sh', 'du -sh a & wait', 'grep -rn "du -sh ~" docs',
    "cat > clean.sh <<'EOF'\ndu -sh ~\nEOF", 'npm run dev &', 'git commit -m "stop du -sh ~ in parallel"']) {
    assert.strictEqual(rule(cmd), null, cmd)
  }
})

test('Windows forms', () => {
  const win = { home: 'C:\\Users\\dev' }
  assert.strictEqual(rule('Get-ChildItem C:\\ -Recurse', { ...win, mode: 'ps' }), 'disk-wide-scan')
  assert.strictEqual(rule('gci $env:USERPROFILE -Recurse -File | Measure-Object Length -Sum', { ...win, mode: 'ps' }), 'disk-wide-scan')
  assert.strictEqual(rule('Get-ChildItem -Path C:\\Users -Recurse', { ...win, mode: 'ps' }), 'disk-wide-scan')
  assert.strictEqual(rule('dir /s C:\\', { ...win, mode: 'cmd' }), 'disk-wide-scan')
  assert.strictEqual(rule('du -sh /c', win), 'disk-wide-scan')
  assert.strictEqual(rule('1..4 | ForEach-Object -Parallel { Get-ChildItem $_ -Recurse }', { ...win, mode: 'ps' }), 'parallel-disk-scan')
  assert.strictEqual(rule('Get-ChildItem .\\src -Recurse', { ...win, mode: 'ps' }), null)
  assert.strictEqual(rule('Get-ChildItem C:\\', { ...win, mode: 'ps' }), null)
})

test('the block says what to run instead', () => {
  const hit = check('du -sh ~', { home })
  assert.match(hit.why, /^\[bulkhead\] disk-guard:/)
  assert.match(hit.why, /one folder at a time/)
  assert.match(check('find / -name x', { home }).why, /-maxdepth/)
})

test('hook blocks with exit 2 and can be turned off', () => {
  const input = { tool_name: 'Bash', tool_input: { command: 'find / -name secrets.json' } }
  const r = runScript('disk-guard', input)
  assert.strictEqual(r.status, 2)
  assert.match(r.stderr, /disk-guard/)
  assert.strictEqual(runScript('disk-guard', input, { BULKHEAD_DISABLE: 'disk-guard' }).status, 0)
  assert.strictEqual(runScript('disk-guard', { tool_name: 'Bash', tool_input: { command: 'du -sh dist' } }).status, 0)
  assert.strictEqual(runScript('disk-guard', 'not json').status, 0)
})
