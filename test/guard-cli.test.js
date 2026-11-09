'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const {spawnSync}=require('child_process')
const fs=require('fs'),os=require('os'),path=require('path'),net=require('net')
const {portConflict}=require('../src/guard')
test('public CLI writes an actual Codex denial, including from a path with spaces',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bulkhead cli '))
  const result=spawnSync(process.execPath,[path.resolve(__dirname,'../bin/codex-bulkhead'),'guard'],{
    input:JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Bash',session_id:'fixture',cwd:dir,tool_input:{command:'pkill node'}}),encoding:'utf8',env:{...process.env,CODEX_BULKHEAD_STATE_DIR:dir}})
  assert.equal(result.status,2)
  assert.match(result.stderr,/kill-guard/)
})
test('port conflict is blocked without stopping its listener',async()=>{
  const server=net.createServer()
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  try {assert.equal((await portConflict(`python3 -m http.server ${server.address().port}`,process.cwd())).rule,'port-in-use');assert(server.listening)}
  finally {await new Promise(resolve=>server.close(resolve))}
})
