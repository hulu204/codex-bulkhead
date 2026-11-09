'use strict'
// Scheduler tests use a deterministic memory snapshot; live benchmarks use the real host.
process.env.BULKHEAD_TEST_MEMORY=JSON.stringify({totalGb:24,freeGb:20,commitPct:null})
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('fs')
const os=require('os')
const path=require('path')
const {spawn}=require('child_process')
const {run,status,validate}=require('../src/runner')
const bin=path.resolve(__dirname,'../bin/codex-bulkhead')
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'codex-bulkhead-test-'))
const close=child=>new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code))})
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function waitFor(check,timeout=3000) {
  const until=Date.now()+timeout
  while(Date.now()<until) {const value=check();if(value)return value;await sleep(20)}
  throw Error('Timed out waiting for test condition')
}
test('six independent processes respect two slots, unique ports, and release state',async()=>{
  const dir=tmp(),out=path.join(dir,'events.jsonl')
  const script=`const fs=require('fs');const emit=k=>fs.appendFileSync(${JSON.stringify(out)},JSON.stringify({k,at:Date.now(),pid:process.pid,port:process.env.BULKHEAD_PORT})+'\\n');emit('start');setTimeout(()=>{emit('end')},150)`
  const codes=await Promise.all(Array.from({length:6},()=>close(spawn(process.execPath,[bin,'run','--jobs','2','--gb','0','--state-dir',dir,'--',process.execPath,'-e',script],{stdio:'pipe'}))))
  assert.deepEqual(codes,Array(6).fill(0))
  const events=fs.readFileSync(out,'utf8').trim().split('\n').map(JSON.parse).sort((a,b)=>a.at-b.at||(a.k==='end'?-1:1))
  let active=new Set(),ports=new Set(),peak=0
  for(const e of events){if(e.k==='start'){assert(!ports.has(e.port));active.add(e.pid);ports.add(e.port);peak=Math.max(peak,active.size)}else{active.delete(e.pid);ports.delete(e.port)}}
  assert.equal(peak,2);assert.equal(active.size,0)
  assert.equal((await status(dir)).active.length,0)
})
test('failure and timeout release permits; exit codes propagate',async()=>{
  const stateDir=tmp()
  const failed=await run({stateDir,gb:0,command:[process.execPath,'-e','process.exit(7)'],stdio:'ignore'})
  assert.equal(failed.code,7)
  const timed=await run({stateDir,gb:0,timeoutMs:100,command:[process.execPath,'-e','setInterval(()=>{},1000)'],stdio:'ignore'})
  assert.equal(timed.code,124);assert.equal((await status(stateDir)).active.length,0)
})
test('conflicting shared capacity fails instead of silently exceeding the cap',async()=>{
  const stateDir=tmp()
  await run({stateDir,jobs:1,gb:0,command:[process.execPath,'-e',''],stdio:'ignore'})
  await assert.rejects(run({stateDir,jobs:4,gb:0,command:[process.execPath,'-e',''],stdio:'ignore'}),/maxJobs=1/)
})
test('invalid inputs and impossible reservations do not launch commands',async()=>{
  assert.throws(()=>validate({jobs:0,gb:1,waitMs:1,timeoutMs:1}),/Invalid/)
  await assert.rejects(run({stateDir:tmp(),gb:1e9,command:[process.execPath,'-e',''],stdio:'ignore'}),/exceeds/)
})
test('runner never executes shell substitution in an argument',async()=>{
  const stateDir=tmp(),file=path.join(stateDir,'should-not-exist')
  const result=await run({stateDir,gb:0,command:[process.execPath,'-e','if(!process.argv[1].startsWith("$("))process.exit(1)',`$(touch ${file})`],stdio:'ignore'})
  assert.equal(result.code,0);assert.equal(fs.existsSync(file),false)
})
test('SIGKILL of a wrapper retains its permit while the detached process group survives',async()=>{
  const stateDir=tmp(),started=path.join(stateDir,'started')
  const child=spawn(process.execPath,[bin,'run','--jobs','1','--gb','0','--state-dir',stateDir,'--',process.execPath,'-e',
    `require('fs').writeFileSync(${JSON.stringify(started)},'ready');setInterval(()=>{},1000)`],{stdio:'ignore'})
  let pgid
  try {
    await waitFor(()=>fs.existsSync(started))
    pgid=JSON.parse(fs.readFileSync(path.join(stateDir,'jobs.json'),'utf8')).active[0].pgid
    assert.equal(typeof pgid,'number')
    process.kill(child.pid,'SIGKILL')
    await close(child)
    assert.equal((await status(stateDir)).active.length,1)
    await assert.rejects(run({stateDir,jobs:1,gb:0,waitMs:80,command:[process.execPath,'-e','']}),/Queue timeout/)
  } finally {
    if(pgid)try{process.kill(-pgid,'SIGKILL')}catch{}
    await sleep(60)
  }
})
test('leader exit with a surviving child is cleaned before its permit is released',async()=>{
  const stateDir=tmp(),started=path.join(stateDir,'grandchild-started')
  const childCode=`process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(started)},'ready');setInterval(()=>{},1000)`
  const leaderCode=`const {spawn}=require('child_process');spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setTimeout(()=>process.exit(0),120)`
  const result=await run({stateDir,gb:0,command:[process.execPath,'-e',leaderCode],stdio:'ignore'})
  assert.equal(result.code,0)
  assert.equal(fs.existsSync(started),true)
  assert.equal((await status(stateDir)).active.length,0)
})
test('a spawn error releases the acquired permit',async()=>{
  const stateDir=tmp()
  await assert.rejects(run({stateDir,gb:0,command:['definitely-not-a-codex-bulkhead-executable']}),/ENOENT/)
  assert.equal((await status(stateDir)).active.length,0)
})
test('SIGTERM escalates promptly even with a long command timeout',async()=>{
  const stateDir=tmp(),started=path.join(stateDir,'started')
  const wrapper=spawn(process.execPath,[bin,'run','--jobs','1','--gb','0','--state-dir',stateDir,'--timeout-ms','300000','--',process.execPath,'-e',
    `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(started)},'ready');setInterval(()=>{},1000)`],{stdio:'ignore'})
  let pgid
  try {
    await waitFor(()=>fs.existsSync(started))
    pgid=JSON.parse(fs.readFileSync(path.join(stateDir,'jobs.json'),'utf8')).active[0].pgid
    const exited=close(wrapper),at=Date.now()
    wrapper.kill('SIGTERM')
    const code=await exited
    assert.equal(code,130);assert(Date.now()-at<5000);assert.equal((await status(stateDir)).active.length,0)
  } finally {try{wrapper.kill('SIGKILL')}catch{};if(pgid)try{process.kill(-pgid,'SIGKILL')}catch{}}
})
