'use strict'
// Cooperative admission only. Never discovers or kills arbitrary system processes.
const fs = require('fs')
const path = require('path')
const os = require('os')
const net = require('net')
const crypto = require('crypto')
const {spawn} = require('child_process')
const {readMemory} = require('../vendor/claude-bulkhead/src/memory')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const root = () => process.env.CODEX_BULKHEAD_STATE_DIR || path.join(os.homedir(), '.codex', 'bulkhead')
function alive(pid) { try {process.kill(pid,0);return true} catch(e) {return e.code==='EPERM'} }
const groupAlive = pgid => alive(-pgid)
function atomic(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value), {mode:0o600}); fs.renameSync(temp,file)
}
async function locked(dir, fn, timeout=10000) {
  fs.mkdirSync(dir,{recursive:true,mode:0o700})
  const lock=path.join(dir,'admission.lock'), start=Date.now()
  for (;;) {
    try {fs.mkdirSync(lock);break} catch(e) {
      if(e.code!=='EEXIST')throw e
      // Never steal locks: competing stale-lock reclaimers can otherwise remove a new holder.
      // A crash inside this tiny critical section requires explicit operator recovery.
      if(Date.now()-start>timeout)throw Error('Admission lock unavailable; inspect the state directory (no job started).')
      await sleep(20)
    }
  }
  fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600})
  try {return await fn()} finally {fs.rmSync(lock,{recursive:true,force:true})}
}
function read(dir,name,fallback) {
  try {return JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'))} catch(e) {if(e.code==='ENOENT')return fallback;throw e}
}
function load(dir) {
  const value=read(dir,'jobs.json',{active:[],waiting:[]})
  // A live PID is conservatively retained, including PID reuse. No unsafe TTL reclaim.
  // The wrapper may be killed while its child keeps running. A launch with no recorded
  // group is uncertain and retains its permit; never optimistically reclaim it.
  value.active=value.active.filter(x=>alive(x.pid)||!x.pgid||groupAlive(x.pgid));value.waiting=value.waiting.filter(x=>alive(x.pid))
  return value
}
async function freePort(excluded=[]) {
  for(let i=0;i<100;i++) {
    const server=net.createServer()
    const port=await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port))})
    await new Promise(resolve=>server.close(resolve))
    if(!excluded.includes(port))return port
  }
  throw Error('No available port found')
}
function validate(options) {
  for(const [name,val] of Object.entries({jobs:options.jobs,gb:options.gb,waitMs:options.waitMs,timeoutMs:options.timeoutMs})) {
    if(!Number.isFinite(val)||val<0||(name==='jobs'&&(!Number.isInteger(val)||val<1||val>64)))throw Error(`Invalid ${name}`)
  }
}
async function acquire(options, cancelled=()=>false) {
  validate(options)
  const dir=options.stateDir||root(), id=crypto.randomUUID(), queuedAt=Date.now()
  const job={id,pid:process.pid,gb:options.gb,queuedAt,cwd:path.resolve(options.cwd||process.cwd()),label:path.basename(options.command[0])}
  let registered=false
  try {
    while(!cancelled()) {
      const acquired=await locked(dir,async()=>{
        let config=read(dir,'limits.json',null)
        if(!config) {config={maxJobs:options.jobs,budgetGb:Math.max(1,os.totalmem()/2**30*0.7)};atomic(path.join(dir,'limits.json'),config)}
        if(config.maxJobs!==options.jobs)throw Error(`Shared state fixes maxJobs=${config.maxJobs}; use the same --jobs value or a separate state directory.`)
        if(options.gb>config.budgetGb)throw Error('Requested GB exceeds the shared memory reservation budget')
        const state=load(dir)
        if(!state.waiting.some(x=>x.id===id)){state.waiting.push(job);registered=true}
        const mem=readMemory()
        const reservation=state.active.reduce((n,x)=>n+x.gb,0)
        const room=state.active.length<config.maxJobs && reservation+options.gb<=config.budgetGb
        const memoryOK=mem.freeGb>=Math.min(3,mem.totalGb*0.15)+options.gb
        if(room && memoryOK && state.waiting[0].id===id) {
          job.startedAt=Date.now();job.port=await freePort(state.active.map(x=>x.port))
          state.waiting=state.waiting.filter(x=>x.id!==id);state.active.push(job)
          atomic(path.join(dir,'jobs.json'),state);return job
        }
        atomic(path.join(dir,'jobs.json'),state);return null
      })
      if(acquired)return acquired
      if(Date.now()-queuedAt>=options.waitMs)throw Error('Queue timeout; no command was started')
      await sleep(40)
    }
    throw Error('Cancelled while queued')
  } catch(error) {
    if(registered)await locked(dir,()=>{const state=load(dir);state.waiting=state.waiting.filter(x=>x.id!==id);atomic(path.join(dir,'jobs.json'),state)})
    throw error
  }
}
async function release(dir,id) {
  await locked(dir,()=>{const state=load(dir);state.active=state.active.filter(x=>x.id!==id);state.waiting=state.waiting.filter(x=>x.id!==id);atomic(path.join(dir,'jobs.json'),state)})
}
async function run(options) {
  options={jobs:2,gb:1,waitMs:60000,timeoutMs:300000,command:[],...options}
  if(!options.command.length)throw Error('Pass an executable and arguments after --')
  if(process.platform==='win32')throw Error('The managed runner currently supports macOS and Linux only')
  const dir=options.stateDir||root();let cancelled=false,child,interrupted=false,timer
  const signal=()=>{cancelled=true;interrupted=true;if(child)try{process.kill(-child.pid,'SIGTERM')}catch{}}
  process.on('SIGINT',signal);process.on('SIGTERM',signal)
  let job,keepPermit=false
  try {
    job=await acquire(options,()=>cancelled)
    if(cancelled)throw Error('Cancelled before command start')
    if(options.onStart)options.onStart(job)
    child=spawn(options.command[0],options.command.slice(1),{cwd:options.cwd||process.cwd(),env:{...process.env,...options.env,BULKHEAD_PORT:String(job.port),CODEX_BULKHEAD_JOB_ID:job.id},detached:true,stdio:options.stdio||'inherit'})
    // Install the error/exit listeners before awaiting metadata writes: ENOENT and very
    // short commands can settle while the lock is being acquired.
    const settled=new Promise(resolve=>{child.once('error',error=>resolve({error}));child.once('exit',(code,sig)=>resolve({code:code===null?128:code,signal:sig}))})
    if(child.pid)await locked(dir,()=>{const state=load(dir);const entry=state.active.find(x=>x.id===job.id);if(!entry)throw Error('Lost admission record');entry.pgid=child.pid;atomic(path.join(dir,'jobs.json'),state)})
    let timedOut=false
    if(options.timeoutMs)timer=setTimeout(()=>{timedOut=true;signal()},options.timeoutMs)
    // A second timer ensures that a process ignoring TERM cannot hold a slot forever.
    let force
    const hardKill=()=>{clearTimeout(force);force=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},1000)}
    process.on('SIGINT',hardKill);process.on('SIGTERM',hardKill)
    if(options.timeoutMs)force=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},options.timeoutMs+1000)
    let result
    try {result=await settled;if(result.error)throw result.error}
    finally {clearTimeout(force);process.off('SIGINT',hardKill);process.off('SIGTERM',hardKill)}
    // Only the process group we just created; never process-name matching or global reaping.
    try {process.kill(-child.pid,'SIGTERM')}catch{}
    await sleep(100)
    try {process.kill(-child.pid,'SIGKILL')}catch{}
    const cleanupDeadline=Date.now()+3000
    while(groupAlive(child.pid)&&Date.now()<cleanupDeadline)await sleep(25)
    if(groupAlive(child.pid)){keepPermit=true;throw Error('Owned process group still exists after cleanup; permit retained for inspection')}
    return {...job,...result,code:timedOut?124:interrupted?130:result.code,finishedAt:Date.now(),timedOut}
  } finally {
    clearTimeout(timer);process.off('SIGINT',signal);process.off('SIGTERM',signal)
    // Also clean up if bookkeeping failed after spawn, before the normal wait path.
    if(child?.pid&&groupAlive(child.pid)) {
      try{process.kill(-child.pid,'SIGTERM')}catch{}
      await sleep(100)
      try{process.kill(-child.pid,'SIGKILL')}catch{}
      const until=Date.now()+3000
      while(groupAlive(child.pid)&&Date.now()<until)await sleep(25)
      if(groupAlive(child.pid))keepPermit=true
    }
    if(job&&!keepPermit)await release(dir,job.id)
  }
}
async function status(dir=root()) {return locked(dir,()=>({limits:read(dir,'limits.json',null),...load(dir),memory:readMemory()}))}
async function main(args) {
  const sep=args.indexOf('--');if(sep<0)throw Error('Usage: run [--jobs N] [--gb N] [--state-dir DIR] -- executable args')
  const options={command:args.slice(sep+1)}
  const names={'--jobs':'jobs','--gb':'gb','--wait-ms':'waitMs','--timeout-ms':'timeoutMs','--state-dir':'stateDir','--cwd':'cwd'}
  for(let i=0;i<sep;i+=2) {
    const key=names[args[i]];if(!key||i+1>=sep)throw Error(`Unknown or incomplete option ${args[i]}`)
    options[key]=['cwd','stateDir'].includes(key)?args[i+1]:Number(args[i+1])
  }
  const result=await run(options);process.exitCode=result.code
}
module.exports={run,main,acquire,release,status,freePort,locked,validate,groupAlive}
