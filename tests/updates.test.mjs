import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
const base=process.env.BC_TEST_URL||'http://127.0.0.1:8787';
test('Lightweight updates, bounded reads and completed-task follow-up',async t=>{
 const cred=JSON.parse(fs.readFileSync(process.env.BC_ACCESS_FILE||'docs/private/admin-access.json'));
 const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(cred)});
 assert.equal(login.status,200);const csrf=(await login.json()).csrf,cookie=login.headers.get('set-cookie').split(';')[0];
 async function admin(name,args){const r=await fetch(base+'/api/'+name,{method:args===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:base,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:args===undefined?undefined:JSON.stringify(args)});const j=await r.json();assert.equal(r.status,200,JSON.stringify(j));return j;}
 const rules=(await admin('me')).rules_version,bots=[],topics=[],groups=[];
 async function call(b,name,args={},error){const r=await b.client.callTool({name,arguments:args});const j=r.structuredContent||JSON.parse(r.content[0].text);if(error){assert.equal(j.error?.code,error);return j;}assert.ok(!r.isError,JSON.stringify(j));return j;}
 const write=(b,name,args={},error)=>call(b,name,{...args,rules_version:rules,idempotency_key:crypto.randomUUID()},error);
 try{
  for(const platform of ['Muse','Grok Bot']){const a=await admin('agent.create',{platform,name:'1.2 local fixture'}),k=await admin('key.create',{agent_id:a.id});const client=new Client({name:'updates-test',version:'1.2'});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+k.key}}}));bots.push({...a,client});await write(bots.at(-1),'register_agent',{capabilities:['updates-test']});}
  const [A,B]=bots;for(let i=0;i<3;i++){const g=await admin('group.create',{name:'1.2 local updates '+i});groups.push(g);await admin('group.members',{id:g.id,members:[A.id,B.id]});}const g=groups[0];
  const initial=await call(B,'check_updates',{known_rules_version:rules});
  const scope={group_ids:[g.id],known_rules_version:rules,known_groups_version:initial.groups_version};
  const first=await call(B,'check_updates',scope);scope.known_members_versions={[g.id]:first.groups[0].members_version};
  const topic=async title=>{const r=await write(A,'create_thread',{group_id:g.id,title,body:'# Fixture',to_ids:[B.id]});topics.push(r.thread.id);return r.thread.id;};
  const task=(th,extra={})=>write(A,'create_task',{thread_id:th,assignee_ids:[B.id],title:'1.2 bounded result',instructions:'Deliver once',acceptance_criteria:'A complete result',...extra});
  await t.test('idle is one compact call; group pagination and version-only guide',async()=>{
   const idle=await call(B,'check_updates',scope);assert.equal(idle.has_updates,false);assert.ok(Buffer.byteLength(JSON.stringify(idle))<1024);assert.equal(idle.groups[0].pending_count,0);
   assert.equal(initial.has_more,true);const next=await call(B,'check_updates',{group_after:initial.next_group_after});assert.ok(next.groups.every(x=>!initial.groups.some(y=>y.id===x.id)));
   const guide=await call(B,'get_guide',{known_rules_version:rules});assert.equal(guide.changed,false);assert.ok(!('guide' in guide));
   await call(B,'check_updates',{group_ids:['not-a-group']},'NOT_FOUND');
  });
  const th=await topic('Lightweight result and reply test');let job;
  await t.test('old tasks remain actionable after event checkpoint advances',async()=>{
   job=await task(th);const cursor=(await call(B,'get_guide',{include_guide:false})).directory_checkpoint.after_seq;
   const r=await call(B,'check_updates',{...scope,checkpoints:[{group_id:g.id,after_seq:cursor}]});assert.equal(r.groups[0].has_new_events,false);assert.equal(r.groups[0].pending_count,1);assert.equal(r.has_updates,true);
   const claim=await write(B,'claim_task',{task_id:job.task.id,expected_version:1});job=await write(B,'update_task',{task_id:job.task.id,expected_version:claim.task.version,lease_token:claim.lease_token,action:'submit',body:'RESULT_ONLY_ONCE_'+('x'.repeat(5000))});assert.ok(!job.message.body.includes('RESULT_ONLY_ONCE'));
  });
  await t.test('fifteen-message incremental topic omits result bodies; truncation is explicit',async()=>{
   for(let i=0;i<11;i++)await write(A,'post_message',{thread_id:th,to_ids:[B.id],body:'## Message '+i+'\n'+('m'.repeat(200))});
   const lean=await call(B,'read_thread',{thread_id:th,limit:100});assert.equal(lean.messages.length,15);assert.ok(!JSON.stringify(lean).includes('RESULT_ONLY_ONCE'));assert.ok(!('instructions' in lean.tasks[0]));
   const full=await call(B,'read_thread',{thread_id:th,include_task_results:true,limit:100});assert.ok(JSON.stringify(full).includes('RESULT_ONLY_ONCE'));assert.ok(Buffer.byteLength(JSON.stringify(lean))<Buffer.byteLength(JSON.stringify(full))*0.7);
   const incremental=await call(B,'read_thread',{thread_id:th,after_seq:lean.messages.at(-1).seq});assert.equal(incremental.messages.length,0);assert.ok(!JSON.stringify(incremental).includes('RESULT_ONLY_ONCE'));
   const summary=await call(B,'read_thread',{thread_id:th,fields:'summary'});assert.ok(summary.messages.every(m=>!('body'in m)&&m.summary.length<=140));
   const metadata=await call(B,'read_thread',{thread_id:th,fields:'metadata'});assert.ok(metadata.messages.every(m=>!('body'in m)&&!('summary'in m)));
   const cut=await call(B,'read_thread',{thread_id:th,max_body_chars:2});assert.ok(cut.messages.every(m=>m.body.length<=2&&m.truncated));
   const stored=await call(B,'get_task',{task_id:job.task.id});assert.match(stored.task.result,/RESULT_ONLY_ONCE/);
  });
  await t.test('terminal-task note retains relation, unanswered request and immutable result',async()=>{
   job=await write(A,'update_task',{task_id:job.task.id,expected_version:job.task.version,action:'accept'});
   const note=await write(A,'post_message',{thread_id:th,task_id:job.task.id,to_ids:[B.id],kind:'note',expects_reply:true,body:'Explain one final point'});
   const cursor=note.message.seq;const r=await call(B,'check_updates',{...scope,checkpoints:[{group_id:g.id,after_seq:cursor}]});assert.equal(r.groups[0].pending_count,0);assert.equal(r.groups[0].pending_reply_count,1);assert.equal(r.has_updates,true);
   const directory=await call(B,'list_directory',{group_id:g.id,after_seq:cursor-1});assert.equal(directory.entries[0].needs_action,true);
   let view=await admin('thread?id='+th);assert.ok(view.waiting.items.some(i=>i.message_id===note.message.id&&i.actor_id===B.id));assert.match(view.messages.find(m=>m.kind==='task_submit').body,/RESULT_ONLY_ONCE/);
   await write(B,'post_message',{thread_id:th,task_id:job.task.id,to_ids:[A.id],kind:'note',reply_to_message_id:note.message.id,body:'Final explanation; no reply required'});
   view=await admin('thread?id='+th);assert.equal(view.waiting.state,'ready_to_close');
   await write(B,'post_message',{thread_id:th,task_id:job.task.id,to_ids:[A.id],kind:'reply',reply_to_message_id:note.message.id,body:'Invalid terminal reply'},'TASK_STOPPED');
   await write(A,'update_task',{task_id:job.task.id,expected_version:job.task.version,action:'cancel'},'TASK_STOPPED');
   assert.equal((await call(B,'get_task',{task_id:job.task.id})).task.status,'completed');
   const audit=await admin('audit');assert.ok(audit.some(x=>x.action==='post_message'&&x.target_id===note.message.id&&JSON.parse(x.details).task_id===job.task.id));
  });
  await t.test('rework preserves each historical submission independently',async()=>{
   let r=await task(th);let c=await write(B,'claim_task',{task_id:r.task.id,expected_version:1});
   r=await write(B,'update_task',{task_id:r.task.id,expected_version:c.task.version,lease_token:c.lease_token,action:'submit',body:'Historical result v1'});
   r=await write(A,'update_task',{task_id:r.task.id,expected_version:r.task.version,action:'request_changes',body:'Make v2'});
   c=await write(B,'claim_task',{task_id:r.task.id,expected_version:r.task.version});
   r=await write(B,'update_task',{task_id:r.task.id,expected_version:c.task.version,lease_token:c.lease_token,action:'submit',body:'Historical result v2'});
   const full=await call(A,'read_thread',{thread_id:th,include_task_results:true,limit:100});
   assert.deepEqual(full.messages.filter(m=>m.task_id===r.task.id&&m.kind==='task_submit').map(m=>m.body),['Historical result v1','Historical result v2']);
   await write(A,'update_task',{task_id:r.task.id,expected_version:r.task.version,action:'accept'});
  });
  await t.test('scheduled work activates without new events; member removal invalidates versions',async()=>{
   const scheduled=await task(th,{start_at:new Date(Date.now()+1200).toISOString()});const cursor=(await call(B,'get_guide',{include_guide:false})).directory_checkpoint.after_seq;
   const args={...scope,checkpoints:[{group_id:g.id,after_seq:cursor}]};assert.equal((await call(B,'check_updates',args)).groups[0].pending_count,0);
   await new Promise(r=>setTimeout(r,1400));const due=await call(B,'check_updates',args);assert.equal(due.groups[0].has_new_events,false);assert.equal(due.groups[0].pending_count,1);
   await admin('group.members',{id:g.id,members:[B.id]});assert.equal((await call(B,'check_updates',args)).groups[0].members_changed,true);
   await admin('group.members',{id:g.id,members:[A.id]});const gone=await call(B,'check_updates',{known_groups_version:initial.groups_version,known_rules_version:rules});assert.equal(gone.groups_changed,true);assert.ok(!gone.groups.some(x=>x.id===g.id));
   await call(B,'check_updates',{group_ids:[g.id]},'FORBIDDEN');await admin('group.members',{id:g.id,members:[A.id,B.id]});
  });
  await t.test('bounded check history contains windows, counts and no result bodies',async()=>{
   const m=await admin('monitoring');const b=m.agents.find(x=>x.agent_id===B.id);assert.ok(b.last_check_at);assert.ok(b.next_expected_at);assert.ok(b.history.length<=20);assert.ok(b.history.some(x=>x.operation==='list_directory'&&x.until_seq));assert.ok(!JSON.stringify(b).includes('RESULT_ONLY_ONCE'));
   assert.equal((await admin('threads')).threads.find(x=>x.id===th).waiting.state,'waiting');
  });
 }finally{for(const id of topics)await admin('thread.control',{id,action:'close',reason:'Local 1.2 acceptance'});for(const b of bots){await admin('agent.disable',{id:b.id});await b.client.close();}for(const g of groups)await admin('group.toggle',{id:g.id});}
});
