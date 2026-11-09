'use strict'
// Read-only, streaming JSONL analysis. No eval, command execution, or command-text output.
const fs = require('fs'), os = require('os'), path = require('path'), readline = require('readline'), crypto = require('crypto')
const { replay } = require('../vendor/claude-bulkhead/src/scan')
const DEFAULT_PATHS = ['sessions','archived_sessions'].map(x=>path.join(os.homedir(),'.codex',x))
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex')
const timestamp = value => typeof value==='number' ? (value<1e12?value*1000:value) : Date.parse(value||'')
function bound(value, now=Date.now()) {
  if(value==null)return null
  const m=/^(\d+(?:\.\d+)?)([hdw])$/.exec(String(value))
  const n=m?now-Number(m[1])*{h:36e5,d:864e5,w:6048e5}[m[2]]:timestamp(value)
  if(!Number.isFinite(n))throw Error('Invalid time; use 30d, 24h or ISO-8601')
  return n
}
function transcriptFiles(paths) {
  const out=[],seen=new Set()
  function visit(p,depth=0) {
    if(depth>6)return
    let st;try{st=fs.lstatSync(p)}catch{return}
    if(st.isSymbolicLink())return
    if(st.isDirectory()){for(const e of fs.readdirSync(p))visit(path.join(p,e),depth+1);return}
    if(st.isFile()&&p.endsWith('.jsonl')){const real=fs.realpathSync(p);if(!seen.has(real)){seen.add(real);out.push({file:real,size:st.size})}}
  }
  for(const p of Array.isArray(paths)?paths:[paths])visit(path.resolve(p))
  return out
}
function shellText(argv) {
  if(typeof argv==='string')return argv
  if(!Array.isArray(argv)||!argv.every(x=>typeof x==='string'))return null
  const i=argv.findIndex(x=>/^-[a-z]*c$/.test(x))
  if(i>=1&&/^(?:ba|z|da|k)?sh$/.test(path.basename(argv[0])))return argv[i+1]||null
  return argv.map(x=>/^[a-zA-Z0-9_./:=@+-]+$/.test(x)?x:"'"+x.replace(/'/g,"'\\''")+"'").join(' ')
}
function directCommand(p) {
  if(p.type!=='function_call'||!/(^|[._])(?:exec_command|shell|shell_command)$/.test(p.name||''))return null
  let a=p.arguments;try{if(typeof a==='string')a=JSON.parse(a)}catch{return null}
  if(!a||typeof a!=='object')return null
  const command=shellText(a.cmd||a.command)
  return command?{id:p.call_id||p.id,command,cwd:a.workdir||a.cwd,kind:'request'}:null
}
function execution(p, observedAt) {
  if(!['item_completed','item.completed'].includes(p.type)||!p.item||!['CommandExecution','commandExecution','command_execution'].includes(p.item.type))return null
  const i=p.item,command=shellText(i.command)
  if(!command)return null
  let start=timestamp(p.started_at_ms??p.startedAtMs),end=timestamp(p.completed_at_ms??p.completedAtMs)
  if(!Number.isFinite(end))end=observedAt
  if(!Number.isFinite(start)&&Number.isFinite(i.durationMs)&&Number.isFinite(end))start=end-i.durationMs
  return {id:i.id,command,cwd:i.cwd,kind:'execution',exitCode:i.exit_code??i.exitCode,status:i.status,start,end}
}
function merge(intervals) {
  const out=[]
  for(const [a,b]of intervals.filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>a).sort((a,b)=>a[0]-b[0])){
    const last=out[out.length-1];if(last&&a<=last[1])last[1]=Math.max(last[1],b);else out.push([a,b])
  }
  return out
}
function overlap(intervals) {
  const points=intervals.flatMap(([a,b])=>[[a,1],[b,-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1])
  let current=0,max=0,at=null
  for(const [t,d]of points){current+=d;if(current>max){max=current;at=new Date(t).toISOString()}}
  return {max,at}
}
function estimatedConcurrency(sessions) {
  const series=new Map()
  for(const s of sessions.values()){
    const mins=[...s.minutes].sort((a,b)=>a-b),own=new Set()
    for(let i=0;i<mins.length;i++){
      const end=i+1<mins.length&&mins[i+1]-mins[i]<=10?mins[i+1]-1:mins[i]
      for(let m=mins[i];m<=end;m++)own.add(m)
    }
    for(const m of own)series.set(m,(series.get(m)||0)+1)
  }
  const minuteSeries=[...series].sort((a,b)=>a[0]-b[0]).map(([m,active])=>({minute:new Date(m*60000).toISOString(),active}))
  const max=minuteSeries.reduce((n,x)=>Math.max(n,x.active),0)
  return {max,at:minuteSeries.find(x=>x.active===max)?.minute||null,minuteSeries}
}
function exactConcurrency(sessions,since=-Infinity,until=Infinity) {
  return overlap([...sessions.values()].flatMap(s=>merge(s.intervals).map(([a,b])=>[Math.max(a,since),Math.min(b,until)]).filter(([a,b])=>b>a))).max
}
async function scan({paths=DEFAULT_PATHS,since='30d',until=Date.now(),now=Date.now()}={}) {
  since=bound(since,now);until=bound(until,now)
  const lower=since??-Infinity,upper=until??Infinity
  if(lower>upper)throw Error('since must be before until')
  const inside=t=>Number.isFinite(t)&&t>=lower&&t<=upper
  const files=transcriptFiles(paths),sessions=new Map(),seenCalls=new Set(),seenTurns=new Set(),calls=[],outcomes=new Map()
  let lines=0,malformed=0,unreadable=0,duplicates=0,unparsedCodeCalls=0,openTasks=0,completeTasks=0,missingTime=0,excludedRequests=0
  const started=Date.now()
  for(const file of files){
    let session=path.basename(file.file),cwd=null,parent=null,createdAt=-Infinity
    const starts=new Map(),requests=[],executions=[]
    try {
      const stream=fs.createReadStream(file.file,{encoding:'utf8'})
      for await(const line of readline.createInterface({input:stream,crlfDelay:Infinity})){
        lines++;let o;try{o=JSON.parse(line)}catch{malformed++;continue}
        const p=o.payload||o,t=timestamp(o.timestamp)
        if(o.type==='session_meta'){
          session=p.id||p.session_id||session;cwd=p.cwd||cwd;parent=p.parent_thread_id||null
          createdAt=timestamp(p.timestamp||o.timestamp);continue
        }
        if(!Number.isFinite(t)){missingTime++;continue}
        // Forked histories can contain events from before this session was created.
        if(t<createdAt){duplicates++;continue}
        if(o.type==='turn_context'&&p.cwd)cwd=p.cwd
        let s=sessions.get(session)
        if(!s){s={cwd,parent,minutes:new Set(),activity:new Map(),intervals:[]};sessions.set(session,s)}
        if(inside(t)){const m=Math.floor(t/60000);s.minutes.add(m);s.activity.set(m,cwd)}
        const turn=p.turn_id||p.task_id
        if(p.type==='task_started'&&turn)starts.set(turn,timestamp(p.started_at)||t)
        if((p.type==='task_complete'||p.type==='task_completed')&&turn){
          const a=starts.get(turn)??timestamp(p.started_at),b=timestamp(p.completed_at)||t
          if(Number.isFinite(a)&&b>a&&b>lower&&a<upper&&!seenTurns.has(turn)){
            seenTurns.add(turn);s.intervals.push([Math.max(a,lower),Math.min(b,upper)]);completeTasks++
          }
          starts.delete(turn)
        }
        if(!inside(t))continue
        if(p.type==='custom_tool_call'&&p.name==='exec')unparsedCodeCalls++
        if(p.type==='function_call_output'){
          let output=p.output;try{if(typeof output==='string'&&output.startsWith('{'))output=JSON.parse(output)}catch{}
          let code=output&&typeof output==='object'?output.exit_code:null
          if(code==null&&typeof output==='string'){const m=/Process exited with code (\d+)/.exec(output);if(m)code=Number(m[1])}
          if(Number.isInteger(code))outcomes.set(p.call_id,code===0?'ok':'error')
        }
        const e=execution(p,t),r=directCommand(p)
        if(e)executions.push({...e,session,cwd:e.cwd||cwd,ts:Number.isFinite(e.start)?e.start:t})
        if(r)requests.push({...r,session,cwd:r.cwd||cwd,ts:t})
      }
      openTasks+=starts.size
      // Prefer observed execution records for files using that schema. Never count both a
      // request and its completion. Legacy transcripts fall back to direct request records.
      const selected=executions.length?executions:requests
      if(executions.length)excludedRequests+=requests.length
      for(const c of selected){
        const key=c.id?`${c.kind}:${c.id}:${hash(c.command)}`:`${c.kind}:${c.ts}:${hash(c.command)}`
        if(seenCalls.has(key)){duplicates++;continue}seenCalls.add(key);calls.push(c)
      }
    }catch{unreadable++}
  }
  for(const [id,s]of sessions)if(!s.minutes.size&&!s.intervals.length)sessions.delete(id)
  // Across exported/forked files, prefer execution over a request with the same stable id.
  const executedIds=new Set(calls.filter(c=>c.kind==='execution'&&c.id).map(c=>c.id))
  for(let i=calls.length-1;i>=0;i--)if(calls[i].kind==='request'&&executedIds.has(calls[i].id)){calls.splice(i,1);excludedRequests++}
  const activity={activity:new Map([...sessions].map(([id,s])=>[id,s.activity]))}
  let ok=0,error=0,executed=0,hitCommands=0,executedHitCommands=0
  const rules=new Map(),shellIntervals=[]
  for(const c of calls){
    if(c.kind==='execution')executed++
    const status=Number.isInteger(c.exitCode)?(c.exitCode===0?'ok':'error'):outcomes.get(c.id)
    if(status==='ok')ok++;if(status==='error')error++
    if(Number.isFinite(c.start)&&Number.isFinite(c.end)&&c.end>c.start)shellIntervals.push([Math.max(c.start,lower),Math.min(c.end,upper)])
    let hits=[];try{hits=replay({tool:'Bash',command:c.command,cwd:c.cwd,ts:c.ts,session:c.session,background:false},activity)}catch{}
    if(hits.length){hitCommands++;if(c.kind==='execution')executedHitCommands++}
    for(const h of hits){const key=`${h.guard}/${h.rule}`,v=rules.get(key)||{rule:key,count:0,observedExecutions:0,requestOnly:0};v.count++;v[c.kind==='execution'?'observedExecutions':'requestOnly']++;rules.set(key,v)}
  }
  const estimated=estimatedConcurrency(sessions),tasks=overlap([...sessions.values()].flatMap(s=>merge(s.intervals))),shell=overlap(shellIntervals.filter(([a,b])=>b>a))
  return {schema:2,generatedAt:new Date().toISOString(),files:files.length,bytes:files.reduce((a,f)=>a+f.size,0),lines,sessions:sessions.size,
    commands:calls.length,observedExecutions:executed,requestOnly:calls.length-executed,hitCommands,executedHitCommands,
    outcomes:{ok,error,unknown:calls.length-ok-error},malformed,unreadable,missingTime,unparsedCodeCalls,excludedRequests,duplicateInherited:duplicates,
    openTasks,completeTasks,seconds:(Date.now()-started)/1000,range:{since,until},
    concurrency:{exactTaskIntervalsMax:tasks.max,exactTaskIntervalsPeakAt:tasks.at,observedShellIntervalsMax:shell.max,
      observedShellIntervalsPeakAt:shell.at,estimatedActiveMinutesMax:estimated.max,estimatedPeakAt:estimated.at,minuteSeries:estimated.minuteSeries},
    rules:[...rules.values()].sort((a,b)=>b.count-a.count),coverage:{commandTextReturned:false,
      note:'规则命中是风险线索，不代表事故。逐文件优先使用 CommandExecution 观测；没有该格式的文件仅分析直接请求；跨文件仅能按稳定ID关联去重。代码模式 JavaScript 不执行、不推测；其实际命令只从 CommandExecution 读取。完成任务区间包含等待，并非模型实际计算时长；未完成区间不计入精确峰值。10分钟内相邻活跃分钟填补为估算。checkout规则会读取当前路径的.git布局，历史目录已移动时可能误判。'}}
}
async function main(args=process.argv.slice(2),io=process){
  const options={paths:[]}
  for(let i=0;i<args.length;i++){
    if(args[i]==='--json')continue
    if(args[i]==='--path'){if(!args[i+1])throw Error('Missing --path');options.paths.push(args[++i]);continue}
    if(['--since','--until'].includes(args[i])){const k=args[i].slice(2);if(!args[i+1])throw Error('Missing time');options[k]=args[++i];continue}
    throw Error(`Unknown scan option ${args[i]}`)
  }
  if(!options.paths.length)delete options.paths
  const result=await scan(options);io.stdout.write(JSON.stringify(result,null,2)+'\n');return result
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1})
module.exports={scan,main,bound,transcriptFiles,shellText,execution,directCommand,overlap,merge,exactConcurrency,estimatedConcurrency}
