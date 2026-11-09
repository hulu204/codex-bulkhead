'use strict'

const crypto = require('crypto')
const checkout = require('../vendor/claude-bulkhead/src/checkout-guard')
const basics = require('../vendor/claude-bulkhead/src/basics')
const disk = require('../vendor/claude-bulkhead/src/disk-guard')
const kill = require('../vendor/claude-bulkhead/src/kill-guard')
const registry = require('./registry')
const net = require('net')
const servers = require('../vendor/claude-bulkhead/src/dev-servers')

async function portConflict(command, cwd) {
  const serverCommand = servers.detect(command, {cwd})
  const port = serverCommand && serverCommand.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  const occupied = await new Promise(resolve => {
    const socket = net.createServer()
    socket.once('error', error => resolve(error.code === 'EADDRINUSE'))
    socket.listen(port, '127.0.0.1', () => socket.close(() => resolve(false)))
  })
  return occupied ? {rule:'port-in-use',reason:`[codex-bulkhead] Port ${port} is already occupied. Choose a free port with codex-bulkhead port, or run the service through codex-bulkhead run and use BULKHEAD_PORT. No process was stopped.`} : null
}

const commandOf = input => {
  const tool = input && input.tool_input
  if (!tool || typeof tool !== 'object') return null
  return typeof tool.command === 'string' ? tool.command : (typeof tool.cmd === 'string' ? tool.cmd : null)
}
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
const deny = (rule, reason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason.replace(/Claude/g,'Codex') },
})

function peerFiles(input) {
  return () => new Map(registry.livePeers(input.session_id).map(peer => [peer.id, peer]))
}

function check(command, input) {
  const cwd = input.cwd || process.cwd()
  const mode = 'sh'
  const basic = basics.check(command, { cwd, mode })
  if (basic) return { rule: basics.ruleOf(basic), reason: basic }
  const killed = kill.classify(command, {}, mode)
  if (killed) return { rule: killed.rule, reason: kill.message(killed.why) }
  const scanned = disk.check(command, { mode })
  if (scanned) return { rule: scanned.rule, reason: scanned.why }
  const changed = checkout.classify(command, {
    cwd,
    sessionId: input.session_id || null,
    mode,
    files: peerFiles(input),
    // Registry records a live Codex session, rather than a PID. Never use process.kill here.
    isAlive: () => true,
  })
  if (changed) return { rule: changed.rule, reason: changed.why }
  return null
}

function lifecycle(input) {
  switch (input.hook_event_name) {
    case 'SessionStart':
    case 'SubagentStart':
      registry.touch(input)
      break
    case 'PreToolUse':
      registry.touch(input)
      break
    case 'SessionEnd':
    case 'SubagentStop':
      registry.removeActor(input)
      break
  }
}

async function main(args = {}) {
  let input = args.input
  if (input === undefined) {
    try {
      const chunks = []
      for await (const chunk of process.stdin) chunks.push(chunk)
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch (error) { return { warning: `bulkhead ignored malformed hook input: ${error.message}` } }
  }
  try {
    if (!input || typeof input !== 'object') return { warning: 'bulkhead ignored malformed hook input' }
    lifecycle(input)
    if (input.hook_event_name !== 'PreToolUse') return { allow: true }
    const command = commandOf(input)
    if (!command) return { allow: true }
    const result = check(command, input) || await portConflict(command, input.cwd || process.cwd())
    if (!result) return { allow: true }
    // No command is written to disk. The caller may turn this into an aggregate audit metric.
    return { deny: deny(result.rule, result.reason), audit: { rule: result.rule, commandHash: hash(command), at: Date.now() } }
  } catch (error) {
    return { warning: `bulkhead guard failed open: ${error.message}` }
  }
}

if (require.main === module) {
  main().then(result => {
    if (result.deny) {process.stderr.write(`${result.deny.hookSpecificOutput.permissionDecisionReason}\n`);process.exitCode=2}
    else if (result.warning) process.stderr.write(`[bulkhead] ${result.warning}\n`)
  }).catch(error => process.stderr.write(`[bulkhead] guard failed open: ${error.message}\n`))
}

module.exports = { main, check, commandOf, deny, portConflict }
