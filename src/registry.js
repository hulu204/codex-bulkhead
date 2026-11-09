'use strict'

// A deliberately small, local session registry. Codex passes the parent session id to
// subagent hooks, so every subagent has its own record and cannot overwrite its siblings.
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const stateDir = () => process.env.CODEX_BULKHEAD_STATE_DIR || path.join(os.homedir(), '.codex', 'bulkhead')
const sessionsDir = dir => path.join(dir || stateDir(), 'sessions')
const safeId = id => crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 24)
const sessionFileFor = (sessionId, dir) => path.join(sessionsDir(dir), `session-${safeId(sessionId)}.json`)
const actorFileFor = (sessionId, agentId, dir) => path.join(sessionsDir(dir), `actor-${safeId(`${sessionId}:${agentId}`)}.json`)
const fileFor = sessionFileFor

function readFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function read(sessionId, { dir } = {}) {
  if (!sessionId) return null
  const value = readFile(sessionFileFor(sessionId, dir))
  return value && value.sessionId === sessionId ? value : null
}

function write(record, { dir, file } = {}) {
  const target = file || sessionFileFor(record.sessionId, dir)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, target)
  } finally {
    try { fs.unlinkSync(temporary) } catch {}
  }
  return record
}

function touch(input = {}, { dir, now = Date.now } = {}) {
  const sessionId = typeof input.session_id === 'string' && input.session_id.trim()
  const cwd = typeof input.cwd === 'string' && input.cwd ? path.resolve(input.cwd) : null
  if (!sessionId || !cwd) return null
  const time = now()
  // agent_id exists for SubagentStart/Stop. PreToolUse does not reliably identify the
  // subagent, therefore it refreshes only the session record and never guesses an actor id.
  if (input.hook_event_name === 'SubagentStart' && typeof input.agent_id === 'string' && input.agent_id) {
    return write({ version: 1, kind: 'actor', sessionId, agentId: input.agent_id, cwd, startedAt: time, updatedAt: time,
      agentType: input.agent_type || null }, { dir, file: actorFileFor(sessionId, input.agent_id, dir) })
  }
  const previous = read(sessionId, { dir })
  return write({ version: 1, kind: 'session', sessionId, cwd, startedAt: previous?.startedAt || time, updatedAt: time }, { dir })
}

function removeActor(input = {}, { dir } = {}) {
  const sessionId = input.session_id
  if (!sessionId) return false
  if (input.hook_event_name === 'SessionEnd') return removeSession(sessionId, { dir })
  if (input.hook_event_name !== 'SubagentStop' || typeof input.agent_id !== 'string') return false
  try { fs.unlinkSync(actorFileFor(sessionId, input.agent_id, dir)); return true } catch { return false }
}

function removeSession(sessionId, { dir } = {}) {
  if (!sessionId) return false
  let names = []
  try { names = fs.readdirSync(sessionsDir(dir)) } catch { return false }
  let removed = false
  for (const name of names) {
    const target = path.join(sessionsDir(dir), name)
    const record = readFile(target)
    if (record?.sessionId !== sessionId) continue
    try { fs.unlinkSync(target); removed = true } catch {}
  }
  return removed
}

function livePeers(sessionId, { dir, now = Date.now, maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
  let names = []
  try { names = fs.readdirSync(sessionsDir(dir)) } catch { return [] }
  const cutoff = now() - maxAgeMs
  return names.flatMap(name => {
    if (!name.endsWith('.json')) return []
    try {
      const value = JSON.parse(fs.readFileSync(path.join(sessionsDir(dir), name), 'utf8'))
      if (value?.kind !== 'session' || !value.sessionId || value.sessionId === sessionId || !value.cwd || (value.updatedAt || 0) < cutoff) return []
      return [{ id: name, cwd: value.cwd, sessionId: value.sessionId, startedAt: value.startedAt || value.updatedAt }]
    } catch { return [] }
  })
}

module.exports = { stateDir, sessionsDir, fileFor, sessionFileFor, actorFileFor, read, write, touch, removeActor, removeSession, livePeers }
