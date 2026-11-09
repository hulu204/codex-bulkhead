'use strict'
const os = require('os')
const { runHook, blocked, oneLine } = require('./hook')
const shell = require('./shell')

// Disk scans that walk a whole drive or home folder, or several folders at once. The disk is
// shared by every session on the machine: one `du` over the home folder, or ten of them through
// xargs -P, keeps it busy for minutes, and every other session's builds, tests and git commands
// crawl until the scans end.

// Programs that read every file under the folders they are given.
const SIZERS = new Set(['du', 'ncdu', 'dust', 'gdu', 'diskus', 'dua', 'duf'])
const PS_WALKERS = new Set(['get-childitem', 'gci', 'ls', 'dir'])

// ~, $HOME and %USERPROFILE% become the home directory. Returns null for anything with a variable
// we cannot expand, so `du -sh "$DIR"` is not guessed at.
function expand(arg, home) {
  const a = String(arg)
    .replace(/^~(?=[\\/]|$)/, home)
    .replace(/^(?:\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%|\$USERPROFILE)(?=[\\/]|$)/i, home)
  return /[$%]/.test(a) ? null : a
}

const clean = p => p.replace(/\\/g, '/').replace(/\/\*$/, '').replace(/\/+$/, '') || '/'

// What a folder argument covers when it is the whole drive, the home folder or every user's home.
function wholeDisk(arg, home) {
  const a = expand(arg, home)
  if (a === null) return null
  const p = clean(a)
  const h = clean(home)
  const lower = p.toLowerCase()
  if (p === '/' || /^[a-z]:\/?$/i.test(p) || /^\/(?:mnt\/)?[a-z]$/i.test(p) || lower === '/system/volumes/data') return 'the whole drive'
  if (p === h || lower === h.toLowerCase()) return 'your whole home folder'
  if (/^(?:\/users|\/home|[a-z]:\/users|\/(?:mnt\/)?[a-z]\/users)$/i.test(p)) return 'every home folder on the machine'
  return null
}

// Folder operands of a sizer or a recursive listing; options and their values are skipped.
function operands(argv) {
  const dir = shell.bin(argv[0]) === 'dir'
  const out = []
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { out.push(...argv.slice(i + 1)); break }
    if (/^-(?:d|-max-depth|-exclude|X|-exclude-from|B|-block-size|t|-threshold|Depth|Filter|Include|Exclude|Path|LiteralPath)$/i.test(a)) {
      if (/^-(?:Path|LiteralPath)$/i.test(a) && argv[i + 1]) out.push(argv[i + 1])
      i++
      continue
    }
    // cmd's dir takes /s and /a; elsewhere /c is a Git Bash drive and stays an operand
    if (a.startsWith('-') || (dir && /^\/[a-z]$/i.test(a))) continue
    out.push(a)
  }
  return out.length ? out : ['.']
}

// Get-ChildItem -Recurse, ls -R (in sh, where ls -r only sorts), and cmd's dir /s.
function recursiveListing(argv, mode) {
  const b = shell.bin(argv[0])
  const args = argv.slice(1)
  if (b === 'get-childitem' || b === 'gci' || (mode === 'ps' && PS_WALKERS.has(b))) return args.some(a => /^-r(?:ecurse)?$/i.test(a))
  if (b === 'ls') return args.some(a => /^-[a-zA-Z]*R/.test(a))
  return b === 'dir' && args.some(a => /^\/s$/i.test(a))
}

function isScan(argv, mode = 'sh') {
  const b = shell.bin(argv[0])
  if (SIZERS.has(b)) return !argv.slice(1).some(a => /^(?:--version|--help)$/.test(a))
  return recursiveListing(argv, mode)
}

// find / and find ~ without -maxdepth walk every file on the drive.
function wideFind(argv, home) {
  if (shell.bin(argv[0]) !== 'find') return null
  if (argv.some(a => /^-maxdepth(?:=|$)/.test(a))) return null
  const starts = []
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (/^-[HLP]$/.test(a)) continue
    if (a.startsWith('-') || a === '(' || a === '!') break
    starts.push(a)
  }
  for (const s of starts) {
    const what = wholeDisk(s, home)
    if (what) return { what, target: s }
  }
  return null
}

// xargs -P N in front of the command (the parser takes the wrapper off its words): N > 1, or 0,
// which means as many as possible. Reads only the command's own prefix, word by word.
function xargsParallel(text, c) {
  const first = c.words && c.words[0]
  if (!first || first.s <= c.s) return false
  const words = text.slice(c.s, first.s).split(/\s+/).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    if (shell.bin(words[i]) !== 'xargs') continue
    for (let k = i + 1; k < words.length; k++) {
      const w = words[k]
      let n = null
      if (w === '-P' || w === '--max-procs') n = words[k + 1]
      else if (/^-P\d+$/.test(w)) n = w.slice(2)
      else if (w.startsWith('--max-procs=')) n = w.slice(12)
      if (n != null && /^\d+$/.test(n) && Number(n) !== 1) return true
    }
  }
  return false
}

// parallel du -sh, rush 'du -sh {}', ForEach-Object -Parallel { Get-ChildItem $_ -Recurse }:
// the scan is an argument of a command that runs it many times at once.
function fanOut(argv, mode) {
  const b = shell.bin(argv[0])
  const runner = /^(?:parallel|rush|xjobs)$/.test(b) ||
    ((b === 'foreach-object' || b === '%') && argv.some(a => /^-parallel$/i.test(a)))
  if (!runner) return false
  for (let i = 1; i < argv.length; i++) {
    const words = argv.slice(i).join(' ').replace(/[{}'"]/g, ' ').trim().split(/\s+/)
    if (isScan(words, mode === 'ps' ? 'ps' : mode)) return true
  }
  return false
}

// The scan runs in parallel: through xargs -P N (N > 1), GNU parallel, ForEach-Object -Parallel,
// Start-Job, or as one of several scans sent to the background with &.
function parallel(text, scans, mode) {
  for (const c of scans) if (xargsParallel(text, c)) return 'through xargs -P'
  if (mode === 'ps' && /\bStart-(?:Thread)?Job\b/i.test(text)) return 'as parallel PowerShell jobs'
  const bg = scans.filter(c => /^[ \t]*&(?!&)/.test(text.slice(c.e)))
  if (bg.length >= 2 || (bg.length === 1 && scans.length >= 2)) return 'as several background jobs'
  // for d in */; do du -sh "$d" & done: one command in the text, many processes
  if (bg.length === 1) {
    const head = text.slice(0, bg[0].e)
    const loop = head.search(/\b(?:for|while|until)\b/)
    if (loop >= 0 && /\bdo\b/.test(head.slice(loop))) return 'as a background job in a loop'
  }
  return null
}

function check(cmd, { home = os.homedir(), mode = 'sh' } = {}) {
  if (typeof cmd !== 'string' || !cmd) return null
  const text = shell.prepare(cmd, mode)
  const cmds = shell.commands(text, mode).filter(c => !c.remote)
  // offsets of commands inside bash -c '...' point into the inner text, so only top-level
  // commands are checked for being run in parallel
  const scans = []
  for (const c of cmds) {
    const seg = oneLine(c.argv.join(' '), 120)
    const found = wideFind(c.argv, home)
    if (found) {
      return {
        rule: 'disk-wide-find',
        why: `[bulkhead] disk-guard: \`${seg}\` walks ${found.what} (${found.target}) with no depth limit.\n` +
          'Other sessions share this disk; a walk over millions of files slows their builds, tests and git for minutes.\n' +
          'Search the folder you mean (find ./src -name ...), or add -maxdepth 3. To find a file by name, try `mdfind`, `locate` or `git ls-files` first.',
      }
    }
    if (c.depth === 0 && fanOut(c.argv, mode)) {
      return {
        rule: 'parallel-disk-scan',
        why: parallelMessage(cmd, 'several at a time'),
      }
    }
    if (!isScan(c.argv, mode)) continue
    if (c.depth === 0) scans.push(c)
    for (const op of operands(c.argv)) {
      const what = wholeDisk(op, home)
      if (what) {
        return {
          rule: 'disk-wide-scan',
          why: `[bulkhead] disk-guard: \`${seg}\` reads ${what} (${op}).\n` +
            'Other sessions share this disk; sizing everything keeps it busy for minutes and slows their work.\n' +
            'Measure one folder at a time, in the foreground: du -sh ./node_modules, or du -sh ~/Library/Caches. Start from the folders you already suspect.',
        }
      }
    }
  }
  if (!scans.length) return null
  const how = parallel(text, scans, mode)
  if (!how) return null
  return { rule: 'parallel-disk-scan', why: parallelMessage(cmd, how) }
}

function parallelMessage(cmd, how) {
  return `[bulkhead] disk-guard: \`${oneLine(cmd, 120)}\` runs disk scans ${how}.\n` +
    'Several scans at once keep the disk at 100% and freeze the other sessions, and they finish no sooner than one at a time.\n' +
    'Run one du at a time, in the foreground: du -sh <one folder>.'
}

if (require.main === module) {
  runHook('disk-guard', input => {
    const cmd = input.tool_input && input.tool_input.command
    const hit = check(cmd, { mode: shell.modeFor(input) })
    if (!hit) return
    return blocked('disk-guard', hit.rule, input, hit.why)
  })
}

module.exports = { check, wholeDisk, isScan }
