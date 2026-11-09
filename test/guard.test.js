'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { main } = require('../src/guard')

const state = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bulkhead-guard-'))
const hook = (session_id, cwd, command, name = 'Bash') => ({ hook_event_name: 'PreToolUse', session_id, cwd, tool_name: name, tool_input: { command } })
const testState = state()
process.env.CODEX_BULKHEAD_STATE_DIR = testState

test('denies shared kill by exec_command cmd fallback and uses the Codex denial shape', async () => {
  const result = await main({ input: { hook_event_name: 'PreToolUse', session_id: 's', cwd: process.cwd(), tool_input: { cmd: 'pkill node' } } })
  assert.equal(result.deny.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(result.deny.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(result.audit.rule, 'pkill')
})

test('allows malformed and commandless input', async () => {
  assert.equal((await main({ input: null })).deny, undefined)
  assert.equal((await main({ input: { hook_event_name: 'PreToolUse', session_id: 's', cwd: process.cwd(), tool_input: {} } })).allow, true)
})

test('blocks shared checkout only with a live peer', async () => {
  const dir = state()
  process.env.CODEX_BULKHEAD_STATE_DIR = dir
  await main({ input: hook('one', process.cwd(), 'true') })
  assert.equal((await main({ input: hook('one', process.cwd(), 'git checkout other') })).deny, undefined)
  await main({ input: hook('two', process.cwd(), 'true') })
  const result = await main({ input: hook('one', process.cwd(), 'git checkout other') })
  assert.equal(result.deny.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(result.deny.hookSpecificOutput.permissionDecisionReason, /checkout-guard/)
  process.env.CODEX_BULKHEAD_STATE_DIR = testState
})
