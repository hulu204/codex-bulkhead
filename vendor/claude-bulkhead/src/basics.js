'use strict'
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { runHook, enabled, setting, blocked, oneLine } = require('./hook')
const shell = require('./shell')
const { realPath } = require('./paths')

// Narrow rules for mistakes that cannot be undone. Each can be turned off on its own:
// rm-root, force-push-main, discard-changes, agent-author.

// ~, $HOME and %USERPROFILE% become the home directory; /c/... becomes C:/... on Windows.
// Returns null for anything with a variable we cannot expand.
function expand(arg, home, platform) {
  let a = arg
    .replace(/^~(?=[\\/]|$)/, home)
    .replace(/^(?:\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%|\$USERPROFILE)(?=[\\/]|$)/i, home)
  if (/[$%]/.test(a)) return null
  if (platform === 'win32') a = a.replace(/^\/([a-z])(?=\/|$)/i, '$1:')
  return a
}

const pathFor = platform => (platform === 'win32' ? path.win32 : path.posix)

const norm = (p, platform) => {
  const n = pathFor(platform).resolve(p).replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return platform === 'win32' ? n.toLowerCase() : n
}
// git prints the repository's real path; the cwd and home may be spelled through a link or a
// Windows short name (C:\Users\RUNNER~1). Only those two folders are resolved, never a target:
// a target can be on an automounted or network path, and a hook must not wait on it. A hook
// process asks for the same two folders again and again, so the answers are kept.
const realCache = new Map()
function realOnce(p) {
  if (!realCache.has(p)) {
    if (realCache.size > 64) realCache.clear()
    realCache.set(p, realPath(p))
  }
  return realCache.get(p)
}
const isAncestorOrSame = (a, b) => b === a || b.startsWith(a.endsWith('/') ? a : a + '/')

function rmTargets(t) {
  const cmd = path.basename(t[0] || '').replace(/\.exe$/i, '').toLowerCase()
  const args = t.slice(1)
  if (cmd === 'rm') {
    // options end at `--`; everything after it is a path, even one that starts with a dash
    const dash = args.indexOf('--')
    const opts = (dash < 0 ? args : args.slice(0, dash)).filter(a => a.startsWith('-'))
    const operands = dash < 0 ? args.filter(a => !a.startsWith('-')) : [...args.slice(0, dash).filter(a => !a.startsWith('-')), ...args.slice(dash + 1)]
    const recursive = opts.some(a => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive')
    const force = opts.some(a => /^-[a-zA-Z]*f/.test(a) || a === '--force')
    return recursive && force ? operands : []
  }
  if (/^(?:remove-item|ri|rmdir|rd|del|erase)$/.test(cmd) && args.some(a => /^-r(?:ecurse)?$/i.test(a)) && args.some(a => /^-fo(?:rce)?$/i.test(a))) {
    return args.filter(a => !a.startsWith('-'))
  }
  if (/^(?:rd|rmdir)$/.test(cmd) && args.some(a => /^\/s$/i.test(a))) return args.filter(a => !/^\/[sq]$/i.test(a))
  return []
}

// Folders directly in the home directory that are only caches and can always be rebuilt.
const HOME_CACHES = /^\.?(?:cache|caches|tmp|temp|npm|pnpm-store|yarn|bun|gradle|m2|nuget|cargo|rustup|deno|expo|Trash|node-gyp|pyenv|bundle|cocoapods)$/i

// The dangerous targets: a filesystem or drive root, a top-level folder such as /usr or /srv,
// the home directory or anything above it, a folder directly in it (~/Documents, ~/backups;
// caches excepted), and any directory above the repository the command runs in.
function dangerousTarget(arg, { cwd, home, platform, repoRoot }) {
  const expanded = expand(arg, home, platform)
  if (expanded === null) return null
  const dir = expanded.replace(/[\\/]\*$/, '') || '/'
  const rel = expanded === '*' ? '.' : dir
  // as written, and on this machine also from the real cwd and home: rm resolves .. from the
  // folder the cwd really is, not from the link it was entered through
  const views = [{ cwd, home }]
  if (platform === process.platform) views.push({ cwd: realOnce(cwd), home: realOnce(home) })
  for (const v of views) {
    const abs = norm(pathFor(platform).resolve(v.cwd, rel), platform)
    if (/^(?:\/|[a-z]:\/?)$/i.test(abs) || /^[a-z]:$/i.test(abs)) return 'a filesystem root'
    const homeKey = norm(v.home, platform)
    if (isAncestorOrSame(abs, homeKey)) return 'your home directory or a folder above it'
    const parent = pathFor('linux').dirname(abs)
    if (parent === homeKey && !HOME_CACHES.test(pathFor('linux').basename(abs))) return 'a folder directly in your home directory'
    if ((parent === '/' || /^[a-z]:\/?$/i.test(parent)) && !isAncestorOrSame(abs, norm(v.cwd, platform))) return 'a top-level folder of the drive'
    // a folder inside the current directory cannot be above the repository
    if (abs !== norm(v.cwd, platform) && isAncestorOrSame(norm(v.cwd, platform), abs)) continue
    const root = repoRoot()
    if (root && abs !== norm(root, platform) && isAncestorOrSame(abs, norm(root, platform))) return 'a folder above this repository'
  }
  return null
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

function gitCwd(t, cwd) {
  const i = t.indexOf('-C')
  return i > 0 && t[i + 1] ? path.resolve(cwd, t[i + 1]) : cwd
}

function gitSub(t) {
  const rest = []
  for (let i = 1; i < t.length; i++) {
    if (t[i] === '-C' || t[i] === '-c') i++
    else rest.push(t[i])
  }
  return rest
}

function forcePushToMain(rest, branch, protectedBranches = ['main', 'master']) {
  if (rest[0] !== 'push') return false
  const args = rest.slice(1)
  // --force-with-lease and --force-if-includes are the safe forms and do not count
  const force = args.some(a => a === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || a.startsWith('+'))
  if (!force) return false
  const refs = args.filter(a => !a.startsWith('-')).slice(1).map(r => r.replace(/^\+/, '').split(':').pop())
  const targets = refs.length ? refs.map(r => (r === 'HEAD' ? branch() : r)) : [branch()]
  return targets.some(r => protectedBranches.includes(String(r || '').replace(/^refs\/heads\//, '')))
}

// An identity that is the agent, not the person: Claude <noreply@anthropic.com> and the like.
const AGENT_ID = /\bclaude\b|anthropic/i

// The --author value of git commit, the value git config sets for user.name or user.email, or a
// -c user.name=... before the subcommand.
function agentAuthor(t, rest) {
  for (let i = 1; i < t.length; i++) {
    if (t[i] === '-c' && /^user\.(?:name|email)=/i.test(t[i + 1] || '') && AGENT_ID.test(t[i + 1].split('=').slice(1).join('='))) return t[i + 1]
  }
  if (rest[0] === 'commit' || rest[0] === 'merge' || rest[0] === 'cherry-pick' || rest[0] === 'revert') {
    for (let i = 1; i < rest.length; i++) {
      const a = rest[i]
      const v = a.startsWith('--author=') ? a.slice(9) : a === '--author' ? rest[i + 1] : null
      if (v && AGENT_ID.test(v)) return `--author ${v}`
    }
  }
  if (rest[0] === 'config') {
    const args = rest.slice(1).filter(a => !/^--(?:global|local|system|worktree|replace-all|add)$/.test(a))
    if (/^user\.(?:name|email)$/i.test(args[0] || '') && args[1] && AGENT_ID.test(args[1])) return `${args[0]} ${args[1]}`
  }
  return null
}

// GIT_AUTHOR_NAME=Claude git commit, export GIT_COMMITTER_EMAIL=noreply@anthropic.com, $env:GIT_AUTHOR_NAME = "Claude"
const AGENT_ENV = /\bGIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)\s*=\s*["']?([^"'\s;&|]*)/gi
function agentEnv(text) {
  for (const m of text.matchAll(AGENT_ENV)) if (AGENT_ID.test(m[1])) return m[0]
  return null
}

function agentMessage(what) {
  return `[bulkhead] basics: \`${oneLine(what, 120)}\` makes the agent the author of the commit.\n` +
    'Commits authored as Claude or Anthropic do not count as the user\'s work on GitHub (contribution graph, achievements), and later blame points at a bot.\n' +
    'Commit with the git identity already configured: leave user.name and user.email alone and drop --author. A Co-Authored-By line in the message is fine.'
}

function check(cmd, {
  cwd = process.cwd(), home = os.homedir(), platform = process.platform, run = git,
  protectedBranches = setting('basics.protectedBranches', ['main', 'master']), mode = 'sh',
} = {}) {
  // each rule's switch and the repository root are read once, however many commands the line has
  const once = fn => { let v; let done = false; return () => (done ? v : ((done = true), (v = fn()))) }
  const rmRoot = once(() => enabled('rm-root'))
  const forcePush = once(() => enabled('force-push-main'))
  const discard = once(() => enabled('discard-changes'))
  const author = once(() => enabled('agent-author'))
  const prepared = shell.prepare(String(cmd || ''), mode)
  const cmds = shell.commands(prepared, mode).filter(x => !x.remote)
  if (author() && /GIT_(?:AUTHOR|COMMITTER)_/i.test(prepared)) {
    // only the shell's own words: a heredoc body handed to python or node is code, not a variable
    const runsGit = cmds.some(c => shell.bin(c.argv[0]) === 'git')
    for (const c of cmds) {
      const own = c.depth === 0 ? prepared.slice(c.s, c.e) : c.argv.join(' ')
      const env = agentEnv(own)
      if (env && (runsGit || /^(?:export|set|setx|\$env:)/i.test(own.trim()))) return agentMessage(env)
    }
  }
  const repoRoot = once(() => { try { return run(['rev-parse', '--show-toplevel'], cwd) } catch { return null } })
  for (const c of cmds) {
    const t = c.argv
    if (!t.length) continue
    const seg = t.join(' ')
    const targets = rmTargets(t)
    if (targets.length && rmRoot()) {
      for (const target of targets) {
        const what = dangerousTarget(target, { cwd, home, platform, repoRoot })
        if (what) {
          return `[bulkhead] basics: \`${oneLine(seg, 120)}\` deletes ${what} (${target}).\n` +
            'Name the folder you mean inside the project instead, for example rm -rf ./dist.'
        }
      }
    }
    if (path.basename(t[0]).replace(/\.exe$/i, '') !== 'git') continue
    const dir = gitCwd(t, cwd)
    const rest = gitSub(t)
    const who = author() && agentAuthor(t, rest)
    if (who) return agentMessage(who)
    if (rest[0] === 'push' && forcePush() && forcePushToMain(rest, () => { try { return run(['rev-parse', '--abbrev-ref', 'HEAD'], dir) } catch { return '' } }, protectedBranches)) {
      return `[bulkhead] basics: force-pushing to ${protectedBranches.join(' or ')} rewrites history other people and sessions have pulled.\n` +
        'Push to a branch, or use --force-with-lease if you are sure.'
    }
    const reset = rest[0] === 'reset' && rest.includes('--hard')
    const clean = rest[0] === 'clean' && rest.some(a => /^-[a-z]*f/.test(a) || a === '--force') && rest.some(a => /^-[a-z]*[dx]/.test(a))
    if ((reset || clean) && discard()) {
      let status
      try { status = run(['status', '--porcelain'], dir) } catch { continue }
      const lines = status.split('\n').filter(Boolean)
      const lost = reset ? lines.filter(l => !l.startsWith('??')) : lines.filter(l => l.startsWith('??'))
      if (lost.length) {
        return `[bulkhead] basics: \`${oneLine(seg, 120)}\` would throw away ${lost.length} ${reset ? 'uncommitted change' : 'untracked file'}${lost.length === 1 ? '' : 's'}` +
          ` (${lost.slice(0, 3).map(l => l.slice(3)).join(', ')}${lost.length > 3 ? ', ...' : ''}).\n` +
          'Commit them or run `git stash push -u` first, so they can be brought back.'
      }
    }
  }
  return null
}

if (require.main === module) {
  runHook('basics', input => {
    const cmd = input.tool_input && input.tool_input.command
    const why = typeof cmd === 'string' && cmd && check(cmd, { cwd: input.cwd || process.cwd(), mode: shell.modeFor(input) })
    if (!why) return
    return blocked('basics', ruleOf(why), input, why)
  })
}

function ruleOf(message) {
  if (/makes the agent the author/.test(message)) return 'agent-author'
  if (/force-pushing/.test(message)) return 'force-push-main'
  if (/would throw away/.test(message)) return 'discard-changes'
  return 'rm-root'
}

module.exports = { check, rmTargets, dangerousTarget, forcePushToMain, ruleOf, agentAuthor }
