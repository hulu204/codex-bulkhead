'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const registry = require('../src/registry')

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bulkhead-registry-'))

test('subagents use independent records and cannot overwrite one another', () => {
  const dir = temp()
  registry.touch({ session_id: 'parent', cwd: dir, hook_event_name: 'SessionStart' }, { dir, now: () => 1 })
  registry.touch({ session_id: 'parent', cwd: dir, hook_event_name: 'SubagentStart', agent_id: 'a', agent_type: 'review' }, { dir, now: () => 2 })
  registry.touch({ session_id: 'parent', cwd: dir, hook_event_name: 'SubagentStart', agent_id: 'b', agent_type: 'test' }, { dir, now: () => 3 })
  assert.equal(registry.read('parent', { dir }).kind, 'session')
  assert.ok(fs.existsSync(registry.actorFileFor('parent', 'a', dir)))
  assert.ok(fs.existsSync(registry.actorFileFor('parent', 'b', dir)))
  registry.removeActor({ session_id: 'parent', hook_event_name: 'SubagentStop', agent_id: 'a' }, { dir })
  assert.equal(fs.existsSync(registry.actorFileFor('parent', 'a', dir)), false)
  assert.ok(fs.existsSync(registry.actorFileFor('parent', 'b', dir)))
})

test('session end removes the session and live peers excludes the caller', () => {
  const dir = temp()
  registry.touch({ session_id: 'one', cwd: dir, hook_event_name: 'SessionStart' }, { dir, now: () => 10 })
  registry.touch({ session_id: 'two', cwd: dir, hook_event_name: 'SessionStart' }, { dir, now: () => 11 })
  assert.equal(registry.livePeers('one', { dir, now: () => 12 }).length, 1)
  registry.removeActor({ session_id: 'two', hook_event_name: 'SessionEnd' }, { dir })
  assert.equal(registry.livePeers('one', { dir, now: () => 12 }).length, 0)
})
