#!/usr/bin/env node
'use strict'
// Live mode makes real Codex requests. Mock mode only validates the scheduler.
const fs=require('fs')
const os=require('os')
const path=require('path')
const {spawn,execFileSync}=require('child_process')
const {run}=require('../src/runner')
const args=process.argv.slice(2)
const opt=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1]}
const live=args.includes('--live')
const levels=opt('--levels','1,2,4').split(',').map(Number)
const count=Number(opt('--tasks','4'))
const output=path.resolve(opt('--output',live?'reports/live.json':'reports/scheduler.json'))
const model=opt('--model',null)
function peak(intervals) {
  const points=intervals.flatMap(([a,b])=>[[a,1],[b,-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1])
  let n=0,max=0;for(const [,d]of points){n+=d;max=Math.max(max,n)}return max
}
async function task(index,jobs,dir) {
  const expected=`BULKHEAD_OK_${index}_${(index+17)*(index+29)}`
  const prompt=`This is a bounded concurrency benchmark. Do not call tools, read files, browse, spawn agents, or edit anything. Compute (${index}+17)*(${index}+29). Reply with exactly BULKHEAD_OK_${index}_ followed by the integer result. No explanation.`
  const executable=live?'codex':process.execPath
  const params=live?['-a','never','exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--sandbox','read-only','--json',...(model?['--model',model]:[]),prompt]:['-e',`setTimeout(()=>console.log(${JSON.stringify(expected)}),250)`]
  const row={index,expected,ok:false,queuedAt:Date.now(),requestEvents:0}
  let stdout='',stderr='',parseBuffer=''
  // The runner's child stdout pipe is inherited by an explicit wrapper process here so every
  // worker has its own PID/permit. The wrapper does not shell-expand the model prompt.
  const cli=path.resolve(__dirname,'../bin/codex-bulkhead')
  const child=spawn(process.execPath,[cli,'run','--jobs',String(jobs),'--gb','0.1','--state-dir',path.join(dir,'state'),
    '--cwd',dir,'--timeout-ms','90000','--wait-ms','600000','--',executable,...params],{stdio:['ignore','pipe','pipe']})
  child.stdout.on('data',data=>{
    const chunk=data.toString();stdout+=chunk;parseBuffer+=chunk
    let at;while((at=parseBuffer.indexOf('\n'))>=0){const line=parseBuffer.slice(0,at);parseBuffer=parseBuffer.slice(at+1)
      if(live)try{const e=JSON.parse(line)
        if(e.type==='turn.started')row.turnStartedAt=Date.now()
        if(e.type==='turn.completed'){row.turnCompletedAt=Date.now();row.usage=e.usage}
        if(e.type==='item.completed'&&e.item?.type==='agent_message')row.answer=e.item.text
        if(e.type==='error')row.error=String(e.message||'Codex error').slice(0,300)
      }catch{}
    }
  })
  child.stderr.on('data',d=>{stderr+=d.toString()})
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
  row.finishedAt=Date.now();row.exitCode=code
  row.ok=code===0&&(live?row.answer?.trim()===expected:stdout.trim()===expected)
  if(!row.ok)row.error=row.error||stderr.slice(-300).replace(/\/Users\/[^/\s]+/g,'~')
  return row
}
async function main() {
  if(!Number.isInteger(count)||count<1||count>32||levels.some(n=>!Number.isInteger(n)||n<1||n>16))throw Error('Invalid bounded test size')
  if(live&&!model)throw Error('--live requires an explicit --model so results identify what was tested')
  const report={schemaVersion:1,kind:live?'codex-cli-live':'scheduler-only',createdAt:new Date().toISOString(),model,
    node:process.version,platform:process.platform,cpuCount:os.cpus().length,totalMemoryGb:Math.round(os.totalmem()/2**30),
    tasksPerLevel:count,levels:[],limitations:['Single exploratory run per level; order and cache may affect timings.',
      'Concurrent turn intervals measure client activity, not simultaneous backend inference.',
      'Tiny arithmetic prompts without tools; does not measure coding productivity or maximum account capacity.',
      'Independent CLI sessions; does not alter native subagent limits.']}
  if(live)report.codexVersion=execFileSync('codex',['--version'],{encoding:'utf8'}).trim()
  for(const jobs of levels) {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-bulkhead-bench-')),startedAt=Date.now()
    const rows=await Promise.all(Array.from({length:count},(_,i)=>task(i,jobs,dir)))
    const wallMs=Date.now()-startedAt,intervals=rows.filter(r=>r.turnStartedAt&&r.turnCompletedAt).map(r=>[r.turnStartedAt,r.turnCompletedAt])
    const success=rows.filter(r=>r.ok).length
    const stage={jobs,wallMs,success,turnOverlapPeak:intervals.length?peak(intervals):null,
      throughputPerMinute:success/(wallMs/60000),speedup:success===count?(report.levels.length?report.levels[0].wallMs/wallMs:1):null,rows}
    report.levels.push(stage)
    fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n')
    console.log(JSON.stringify({jobs,success:stage.success,total:count,wallSeconds:+(wallMs/1000).toFixed(2),turnOverlapPeak:stage.turnOverlapPeak,speedup:+stage.speedup.toFixed(2)}))
    if(stage.success!==count){console.error('Stopping after first failing level; no automatic retries.');process.exitCode=1;break}
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1})
module.exports={peak}
