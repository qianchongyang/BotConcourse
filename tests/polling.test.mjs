import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
const base=process.env.BC_TEST_URL||'http://127.0.0.1:8787';
test('Incremental windows, durable unfinished work and versioned rosters',async t=>{
 const cred=JSON.parse(fs.readFileSync(process.env.BC_ACCESS_FILE||'docs/private/admin-access.json'));const bots=[],topics=[];let cookie='',csrf='',rules;
 async function admin(name,args){const r=await fetch(base+'/api/'+name,{method:args===undefined?'GET':'POST',headers:{Origin:base,Cookie:cookie,'X-CSRF-Token':csrf,...args!==undefined?{'Content-Type':'application/json'}:{}},body:args!==undefined?JSON.stringify(args):undefined});const j=await r.json();assert.equal(r.status,200,JSON.stringify(j));return j;}
 const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(cred)});assert.equal(login.status,200);csrf=(await login.json()).csrf;cookie=login.headers.get('set-cookie').split(';')[0];rules=(await admin('me')).rules_version;
 const call=async(b,name,args={},error)=>{const r=await b.client.callTool({name,arguments:args}),j=r.structuredContent||JSON.parse(r.content[0].text);if(error){assert.equal(j.error?.code,error);return j;}assert.ok(!r.isError,JSON.stringify(j));return j;};
 const write=(b,name,args={},error)=>call(b,name,{...args,rules_version:rules,idempotency_key:crypto.randomUUID()},error);
 let group;
 try {
  for(const platform of ['Muse','Grok Bot','ChatGPT dots','Muse']){const a=await admin('agent.create',{platform,name:'Polling simulated fixture'}),key=await admin('key.create',{agent_id:a.id});const client=new Client({name:'polling-test',version:'1.1'});bots.push({...a,client});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+key.key}}}));await write(bots.at(-1),'register_agent',{capabilities:['Markdown','polling-test']});}
  const [A,B,C,D]=bots;group=await admin('group.create',{name:'Polling acceptance · '+new Date().toISOString()});await admin('group.members',{id:group.id,members:[A.id,B.id,C.id]});
  const topic=async title=>{const r=await write(A,'create_thread',{group_id:group.id,title,body:'## Incremental fixture',to_ids:[B.id]});topics.push(r.thread.id);return r.thread.id;};
  const task=(thread,extra={})=>write(A,'create_task',{thread_id:thread,assignee_ids:[B.id],title:'Persistent unfinished work',instructions:'**Deliver** evidence',acceptance_criteria:'Verified result',...extra});
  await t.test('registration states the real host schedule contract',async()=>{const guide=await call(B,'get_guide',{language:'zh'});assert.equal(guide.polling.interval_seconds,300);assert.equal(guide.polling.scheduler,'host_required');assert.equal(guide.polling.page_size,20);assert.match(guide.guide,/until_seq/);const brief=await call(B,'get_guide',{include_guide:false});assert.ok(!('guide'in brief));assert.ok(brief.groups.some(g=>g.id===group.id));const reg=await write(B,'register_agent',{capabilities:['Markdown','polling-test']});assert.equal(reg.polling.interval_seconds,300);assert.ok(reg.directory_checkpoint.after_seq>=0);assert.deepEqual(reg.next,['list_group_members','list_my_tasks','list_directory']);});
  await t.test('frozen windows catch delayed events exactly once, including empty windows',async()=>{
   const start=(await call(B,'get_guide')).directory_checkpoint.after_seq,th=await topic('Frozen incremental window');await write(A,'post_message',{thread_id:th,to_ids:[B.id],body:'Second addressed record'});
   const first=await call(B,'list_directory',{group_id:group.id,after_seq:start,limit:1});assert.equal(first.has_more,true);const upper=first.window.until_seq;await write(A,'post_message',{thread_id:th,to_ids:[B.id],body:'Arrived during pagination'});
   const second=await call(B,'list_directory',{group_id:group.id,after_seq:first.next_after_seq,until_seq:upper,limit:1});assert.equal(second.has_more,false);assert.equal(second.next_after_seq,upper);assert.ok(second.entries.every(e=>e.seq<=upper));
   const next=await call(B,'list_directory',{group_id:group.id,after_seq:upper});assert.equal(next.entries.length,1);assert.match(next.entries[0].summary,/during pagination/);assert.ok(!('body'in next.entries[0]));
   await write(A,'post_message',{thread_id:th,to_ids:[C.id],body:'Not addressed to B'});const empty=await call(B,'list_directory',{group_id:group.id,after_seq:next.next_after_seq});assert.equal(empty.entries.length,0);assert.ok(empty.next_after_seq>next.next_after_seq);assert.equal(empty.retry_after_seconds,300);
   await call(B,'list_directory',{after_seq:empty.next_after_seq,until_seq:upper},'VALIDATION');
  });
  await t.test('older unfinished tasks survive fresh checkpoints; terminal and scheduled work do not',async()=>{
   const th=await topic('Unfinished independent from event age'),old=await task(th),other=await task(th),scheduled=await task(th,{start_at:new Date(Date.now()+3600000).toISOString()});
   const checkpoint=(await call(B,'get_guide')).directory_checkpoint.after_seq;assert.equal((await call(B,'list_directory',{group_id:group.id,after_seq:checkpoint})).entries.length,0);
   const all=await call(B,'list_my_tasks',{group_id:group.id,limit:1});assert.equal(all.tasks.length,1);assert.equal(all.has_more,true);assert.ok(!('instructions'in all.tasks[0]));const page=await call(B,'list_my_tasks',{group_id:group.id,limit:1,after_task_id:all.next_after_task_id});assert.equal(page.has_more,false);assert.deepEqual(new Set([...all.tasks,...page.tasks].map(x=>x.id)),new Set([old.task.id,other.task.id]));
   await write(B,'claim_task',{task_id:scheduled.task.id,expected_version:1},'NOT_STARTED');await write(A,'update_task',{task_id:other.task.id,expected_version:1,action:'cancel'});
   const claim=await write(B,'claim_task',{task_id:old.task.id,expected_version:1});const waiting=await write(B,'update_task',{task_id:old.task.id,expected_version:claim.task.version,lease_token:claim.lease_token,action:'need_input',body:'Which format?'});
   assert.equal((await call(B,'list_my_tasks',{group_id:group.id})).tasks.length,0);assert.equal((await call(B,'list_my_tasks',{group_id:group.id,actionable_only:false})).tasks[0].status,'waiting_input');
   const resumed=await write(B,'update_task',{task_id:old.task.id,expected_version:waiting.task.version,lease_token:claim.lease_token,action:'resume',body:'Markdown confirmed'});await write(B,'update_task',{task_id:old.task.id,expected_version:resumed.task.version,lease_token:claim.lease_token,action:'submit',body:'## Result\nVerified'});
   assert.equal((await call(B,'list_my_tasks',{group_id:group.id})).tasks.length,0);const review=await call(A,'list_my_tasks',{group_id:group.id});assert.equal(review.tasks[0].id,old.task.id);assert.equal(review.tasks[0].role,'issuer');await write(A,'update_task',{task_id:old.task.id,expected_version:review.tasks[0].version,action:'accept'});assert.equal((await call(A,'list_my_tasks',{group_id:group.id})).tasks.length,0);
   await write(A,'create_task',{thread_id:th,assignee_ids:[B.id],title:'Invalid execution dates',instructions:'x',acceptance_criteria:'x',start_at:new Date(Date.now()+3600000).toISOString(),due_at:new Date(Date.now()+1000).toISOString()},'VALIDATION');
  });
  await t.test('roster versions identify joins, departures, capabilities and canonical names',async()=>{
   const r=await call(A,'list_group_members',{group_id:group.id});assert.equal(r.members.length,3);assert.ok(r.members.some(m=>m.name.startsWith('Grok Bot · ')));assert.ok(r.members.every(m=>m.alias==='Polling simulated fixture'));assert.equal(A.name,'Muse · '+A.id.slice(-8));assert.notEqual(A.name,D.name);
   const same=await call(A,'list_group_members',{group_id:group.id,known_version:r.version});assert.equal(same.changed,false);assert.ok(!('members'in same));await call(D,'list_group_members',{group_id:group.id},'FORBIDDEN');await call(D,'list_my_tasks',{group_id:group.id},'FORBIDDEN');
   await admin('group.members',{id:group.id,members:[A.id,B.id,D.id]});const changed=await call(A,'list_group_members',{group_id:group.id,known_version:r.version});assert.equal(changed.changed,true);assert.ok(changed.members.some(m=>m.id===D.id));assert.ok(!changed.members.some(m=>m.id===C.id));await call(C,'list_group_members',{group_id:group.id},'FORBIDDEN');
   await write(D,'register_agent',{capabilities:['updated capability']});const caps=await call(A,'list_group_members',{group_id:group.id,known_version:changed.version});assert.equal(caps.changed,true);await admin('agent.disable',{id:D.id});const disabled=await call(A,'list_group_members',{group_id:group.id,known_version:caps.version});assert.equal(disabled.members.find(m=>m.id===D.id).status,'disabled');
   await admin('group.toggle',{id:group.id});assert.equal((await call(B,'list_my_tasks',{group_id:group.id})).tasks.length,0);
  });
 } finally {for(const id of topics)await admin('thread.control',{id,action:'close',reason:'Polling acceptance complete'});for(const b of bots){await admin('agent.disable',{id:b.id});await b.client.close();}if(group&&(await admin('overview')).groups.find(g=>g.id===group.id)?.status==='active')await admin('group.toggle',{id:group.id});}
});
