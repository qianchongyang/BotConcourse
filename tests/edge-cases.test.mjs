import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
const base=process.env.BC_TEST_URL||'http://127.0.0.1:8787';
test('Deadline, cancellation, access and pagination edge cases',async t=>{
 const cred=JSON.parse(fs.readFileSync(process.env.BC_ACCESS_FILE||'docs/private/admin-access.json'));let csrf='',cookie='',rules;const bots=[],topics=[];
 async function admin(name,args){const r=await fetch(base+'/api/'+name,{method:args===undefined?'GET':'POST',headers:{Origin:base,Cookie:cookie,'X-CSRF-Token':csrf,...(args!==undefined?{'Content-Type':'application/json'}:{})},body:args!==undefined?JSON.stringify(args):undefined});const j=await r.json();assert.equal(r.status,200,JSON.stringify(j));return j;}
 const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(cred)});assert.equal(login.status,200);csrf=(await login.json()).csrf;cookie=login.headers.get('set-cookie').split(';')[0];rules=(await admin('me')).rules_version;
 for(const name of['Edge issuer','Edge executor','Edge reviewer']){const a=await admin('agent.create',{name,platform:'测试'}),key=await admin('key.create',{agent_id:a.id});const client=new Client({name:'edge-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+key.key}}}));bots.push({...a,client});}
 async function call(b,name,args={},error){const r=await b.client.callTool({name,arguments:args}),data=r.structuredContent||JSON.parse(r.content[0].text);if(error){assert.equal(data.error?.code,error);return data;}assert.ok(!r.isError,JSON.stringify(data));return data;}
 const write=(b,name,args={},error)=>call(b,name,{...args,idempotency_key:crypto.randomUUID(),rules_version:rules},error);
 const[A,B,C]=bots;for(const b of bots)await write(b,'register_agent',{capabilities:['edge-test']});const group=await admin('group.create',{name:'Edge cases · '+new Date().toISOString()});await admin('group.members',{id:group.id,members:bots.map(b=>b.id)});
 const topic=async title=>{const r=await write(A,'create_thread',{group_id:group.id,title,body:'Edge case fixture',to_ids:['all']});topics.push(r.thread.id);return r;};
 const task=(thread,more={})=>write(A,'create_task',{thread_id:thread,assignee_ids:[B.id],title:'Edge task',instructions:'Deliver a tested result',acceptance_criteria:'Result checked',...more});
 try {
 await t.test('deadlines normalize timezone offsets and stop expired work',async()=>{
   const th=await topic('Deadline and timezone');const future=new Date(Date.now()+2000);const offsetTime=new Date(future.getTime()+8*3600000).toISOString().replace('Z','+08:00');const j=await task(th.thread.id,{due_at:offsetTime});assert.equal(j.task.due_at,future.toISOString());await new Promise(r=>setTimeout(r,2200));const exp=await call(B,'get_task',{task_id:j.task.id});assert.equal(exp.task.status,'expired');await write(B,'claim_task',{task_id:j.task.id,expected_version:exp.task.version},'CONFLICT');
 });
 await t.test('cancelling an aggregate cancels all descendants with traceable events',async()=>{
   const th=await topic('Cancellation cascade');const j=await task(th.thread.id,{assignee_ids:[B.id,C.id]});await write(A,'update_task',{task_id:j.task.id,expected_version:1,action:'cancel',body:'No longer needed'});const read=await call(B,'read_thread',{thread_id:th.thread.id});assert.ok(read.tasks.every(x=>x.status==='cancelled'));assert.equal(read.messages.filter(m=>m.kind==='task_cancel').length,3);assert.ok(read.tasks.every(x=>!('lease_token'in x)));
 });
 await t.test('group pause stops writes; member removal stops reads',async()=>{
   const th=await topic('Membership boundary');await admin('group.toggle',{id:group.id});await write(B,'post_message',{thread_id:th.thread.id,to_ids:[A.id],body:'Cannot write'},'GROUP_PAUSED');await admin('group.toggle',{id:group.id});await admin('group.members',{id:group.id,members:[A.id,B.id]});await call(C,'read_thread',{thread_id:th.thread.id},'FORBIDDEN');await admin('group.members',{id:group.id,members:bots.map(x=>x.id)});
 });
 await t.test('wrong reply parent is rejected and sequence pagination has no gaps',async()=>{
   const one=await topic('First isolated topic');const two=await topic('Second isolated topic');await write(B,'post_message',{thread_id:two.thread.id,to_ids:[A.id],kind:'reply',reply_to_message_id:one.message.id,body:'Wrong thread'},'VALIDATION');for(let i=0;i<5;i++)await write(B,'post_message',{thread_id:two.thread.id,to_ids:[A.id],body:'Entry '+i});let cursor=0,seen=[];for(let i=0;i<30;i++){const page=await call(A,'list_directory',{group_id:group.id,after_seq:cursor,limit:2,inbox_only:false});seen.push(...page.entries.map(e=>e.seq));cursor=page.next_after_seq;if(!page.has_more)break;}assert.equal(new Set(seen).size,seen.length);assert.ok(seen.every((v,i)=>i===0||v>seen[i-1]));const all=(await admin('export')).events.filter(e=>e.group_id===group.id).map(e=>e.seq);assert.deepEqual(seen,all);
 });
 await t.test('open tasks prevent closing; task count bound is enforced',async()=>{
   const th=await topic('Task bounds');await task(th.thread.id);await write(A,'close_thread',{thread_id:th.thread.id,summary:'Too early'},'OPEN_TASKS');for(let i=0;i<11;i++)await task(th.thread.id);await task(th.thread.id).then(()=>assert.fail('13th task must fail'),e=>assert.match(e.message,/LIMIT_REACHED/));
 });
 } finally {for(const id of topics)await admin('thread.control',{id,action:'close',reason:'Edge test complete'});for(const b of bots){await admin('agent.disable',{id:b.id});await b.client.close();}}
});
