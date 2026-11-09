'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path')
const {scan,bound,overlap,estimatedConcurrency,shellText}=require('../src/scan')
const t=m=>Date.UTC(2026,10,9,1,m),row=(m,payload,type='event_msg')=>({timestamp:new Date(t(m)).toISOString(),type,payload})
const meta=id=>row(0,{id,cwd:'/repo'},'session_meta')
const request=(m,id,cmd)=>row(m,{type:'function_call',call_id:id,name:'exec_command',arguments:JSON.stringify({cmd})},'response_item')
const completed=(m,id,cmd)=>row(m,{type:'item_completed',started_at_ms:t(m)-500,completed_at_ms:t(m),item:{type:'CommandExecution',id,command:['/bin/zsh','-lc',cmd],exit_code:0,cwd:'/repo'}})
function files(map){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bulkhead-scan-'));for(const [name,rows]of Object.entries(map))fs.writeFileSync(path.join(dir,name+'.jsonl'),rows.map(JSON.stringify).join('\n'));return dir}
const options=paths=>({paths,since:t(0),until:t(10)})
test('relative/absolute time and invalid input',()=>{assert.equal(bound('30d',t(0)),t(0)-30*864e5);assert.equal(bound(new Date(t(0)).toISOString()),t(0));assert.throws(()=>bound('wat'),/Invalid/)})
test('observed execution supersedes request; code strings are never executed or disclosed',async()=>{
 const p=files({a:[meta('a'),request(1,'r','pkill node'),row(1,{type:'custom_tool_call',name:'exec',input:'process.exit(99)'},'response_item'),completed(2,'x','pkill node')]})
 const r=await scan(options(p));assert.equal(r.commands,1);assert.equal(r.observedExecutions,1);assert.equal(r.outcomes.ok,1);assert.equal(r.excludedRequests,1);assert.equal(r.hitCommands,1);assert.equal(r.unparsedCodeCalls,1);assert(!JSON.stringify(r).includes('pkill node'))
})
test('legacy direct calls remain request-only and unknown without proof',async()=>{
 const p=files({a:[meta('a'),request(1,'r','echo ok'),row(2,{type:'function_call_output',call_id:'r',output:'HTTP 200'},'response_item')]})
 const r=await scan(options(p));assert.equal(r.requestOnly,1);assert.equal(r.outcomes.unknown,1)
})
test('same session is counted only once per minute; ends sort before starts',()=>{
 assert.equal(estimatedConcurrency(new Map([['s',{minutes:new Set([1,2,3])}]])).max,1)
 assert.equal(overlap([[1,2],[2,3]]).max,1)
})
test('tasks pair by turn id, clip to range, and omit old sessions',async()=>{
 const start=(m,id)=>row(m,{type:'task_started',turn_id:id}),end=(m,id)=>row(m,{type:'task_complete',turn_id:id})
 const p=files({a:[meta('a'),start(1,'a'),end(5,'a')],b:[meta('b'),start(3,'b'),end(6,'b')],old:[meta('old')]})
 const r=await scan({paths:p,since:t(2),until:t(5)});assert.equal(r.sessions,2);assert.equal(r.concurrency.exactTaskIntervalsMax,2);assert.equal(r.completeTasks,2)
})
test('copied fork execution and task ids are deduplicated',async()=>{
 const body=[row(1,{type:'task_started',turn_id:'turn'}),completed(2,'same','echo ok'),row(3,{type:'task_complete',turn_id:'turn'})]
 const p=files({a:[meta('a'),...body],b:[meta('b'),...body]});const r=await scan(options(p));assert.equal(r.commands,1);assert.equal(r.completeTasks,1)
})
test('malformed or missing timestamps do not discard the rest of a file',async()=>{
 const p=files({a:[meta('a'),{type:'response_item',payload:{}},completed(2,'x','echo ok')]});fs.appendFileSync(path.join(p,'a.jsonl'),'\n{broken')
 const r=await scan(options(p));assert.equal(r.malformed,1);assert.equal(r.missingTime,1);assert.equal(r.commands,1);assert.equal(r.unreadable,0)
})
test('shell argv conversion preserves non-shell arguments as quoted text',()=>{assert.equal(shellText(['/bin/zsh','-lc','echo ok']),'echo ok');assert.equal(shellText(['echo','a; pkill node']),"echo 'a; pkill node'")})
test('camelCase exported events and cross-file request/execution ids are supported',async()=>{
 const event={timestamp:new Date(t(2)).toISOString(),type:'item.completed',item:{type:'commandExecution',id:'same',command:'echo ok',cwd:'/repo',exitCode:0,durationMs:500}}
 const p=files({a:[meta('a'),request(1,'same','echo ok')],b:[meta('b'),event]})
 const r=await scan(options(p));assert.equal(r.commands,1);assert.equal(r.observedExecutions,1);assert.equal(r.concurrency.observedShellIntervalsMax,1)
})
