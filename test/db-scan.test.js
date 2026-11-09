'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

const script = join(__dirname, '..', 'src', 'db-scan.py')
function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), 'db-scan-')), 'history.sqlite')
  const create = [
    'import sqlite3,sys',
    'c=sqlite3.connect(sys.argv[1])',
    'c.execute("create table thread_turns(thread_id text,turn_id text,started_at real,completed_at real,status text,error_json text)")',
    "c.executemany('insert into thread_turns values(?,?,?,?,?,?)',[('a','1',1,5,'ok',None),('a','2',4,8,'ok',None),('a','3',8,9,'ok',None),('b','1',3,6,'ok',None),('c','1',20,21,'ok',None),('bad','1',9,7,'ok',None)])",
    'c.commit()',
  ].join(';')
  assert.equal(spawnSync('python3', ['-c', create, file]).status, 0)
  return file
}
function run(file, since, until) {
  return spawnSync('python3', [script, '--path', file, '--since-ms', String(since), '--until-ms', String(until)], { encoding: 'utf8' })
}
test('projects seconds timestamps, merges same-thread overlap and clips range', () => {
  const out = run(fixture(), 2000, 9000)
  assert.equal(out.status, 0, out.stderr)
  const r = JSON.parse(out.stdout)
  assert.equal(r.source, 'sqlite-projection')
  assert.equal(r.completeIntervals, 4)
  assert.equal(r.sessions, 2)
  assert.equal(r.peak, 2)
  assert.equal(r.peakAt, 3000)
  assert.deepEqual(r.range, { sinceMs: 2000, untilMs: 9000 })
})
test('reports missing required table clearly', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'db-scan-')), 'empty.sqlite')
  assert.equal(spawnSync('python3', ['-c', 'import sqlite3,sys; sqlite3.connect(sys.argv[1]).close()', file]).status, 0)
  const out = run(file, 0, 1000)
  assert.equal(out.status, 1)
  assert.match(out.stderr, /thread_turns is missing/)
})
