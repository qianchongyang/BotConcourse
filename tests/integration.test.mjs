import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';

const base=process.env.BC_TEST_URL||'http://127.0.0.1:8787';
const credentials=JSON.parse(fs.readFileSync(process.env.BC_ACCESS_FILE||'docs/private/admin-access.json','utf8'));
const clients=[],issued=[],agents=[],threads=[];let cookie='',csrf='',rules='',group,otherGroup;
const uuid=()=>crypto.randomUUID();
async function http(path,data,extra={}){return fetch(base+path,{method:data===undefined?'GET':'POST',headers:{Origin:base,...(cookie?{Cookie:cookie}:{}),...(data===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf}),...extra},body:data===undefined?undefined:JSON.stringify(data)});}
async function admin(path,data){const r=await http('/api/'+path,data);const j=await r.json();assert.equal(r.status,200,JSON.stringify(j));return j;}
async function bot(name){const agent=await admin('agent.create',{name,platform:'测试'});agents.push(agent);const key=await admin('key.create',{agent_id:agent.id});issued.push(key);const client=new Client({name:'botconcourse-scenario-test',version:'1.0.0'});const transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+key.key}}});await client.connect(transport);clients.push(client);return {agent,key,client};}
async function call(bot,name,args={},raw=false){const r=await bot.client.callTool({name,arguments:args});const data=r.structuredContent||JSON.parse(r.content.find(x=>x.type==='text').text);if(!raw)assert.ok(!r.isError,JSON.stringify(data));return {data,isError:!!r.isError};}
async function write(bot,name,args={},raw=false){return call(bot,name,{...args,idempotency_key:uuid(),rules_version:rules},raw);}
async function error(bot,name,args,code){const r=await write(bot,name,args,true);assert.equal(r.isError,true);assert.equal(r.data.error.code,code);}
async function topic(bot,title,to){const r=await write(bot,'create_thread',{group_id:group.id,title,body:'## Scenario\nA reproducible collaboration test.',to_ids:to});threads.push(r.data.thread.id);return r.data;}
async function task(bot,thread,assignees,title='Deliver a result'){return (await write(bot,'create_task',{thread_id:thread,assignee_ids:assignees,title,instructions:'Return a Markdown answer with evidence.',acceptance_criteria:'Answer contains a clear result and limitations.'})).data;}
async function finish(executor,issuer,job){const claimed=(await write(executor,'claim_task',{task_id:job.id,expected_version:job.version})).data;const submitted=(await write(executor,'update_task',{task_id:job.id,expected_version:claimed.task.version,lease_token:claimed.lease_token,action:'submit',body:'## Result\n- Completed\n- Evidence: test fixture',evidence:['scenario-fixture']})).data;const accepted=(await write(issuer,'update_task',{task_id:job.id,expected_version:submitted.task.version,action:'accept',body:'Verified against the acceptance criteria.'})).data;assert.equal(accepted.task.status,'completed');return accepted.task;}

test('BotConcourse HTTP + MCP end-to-end collaboration',async t=>{
  let A,B,C,D;
  await t.test('authentication is mandatory; login has secure independent session',async()=>{
    assert.equal((await fetch(base+'/mcp')).status,401);
    assert.equal((await fetch(base+'/api/overview')).status,401);
    const r=await http('/api/login',{username:credentials.username,password:credentials.password});assert.equal(r.status,200,await r.clone().text());const c=r.headers.get('set-cookie');assert.match(c,/HttpOnly/);assert.match(c,/SameSite=Strict/);if(base.startsWith('https:'))assert.match(c,/Secure/);cookie=c.split(';')[0];csrf=(await r.json()).csrf;assert.ok(csrf);
    const me=await admin('me');rules=me.rules_version;assert.equal(me.username,credentials.username);
  });
  await t.test('CSRF, Origin, method and body-size controls',async()=>{
    assert.equal((await http('/api/group.create',{name:'forbidden'},{'X-CSRF-Token':'wrong'})).status,403);
    assert.equal((await http('/api/group.create',{name:'forbidden'},{Origin:'https://untrusted.example'})).status,403);
    assert.equal((await http('/api/group.create')).status,404);
    assert.equal((await http('/api/group.create',{name:'x'.repeat(65000)})).status,413);
    assert.equal((await http('/mcp',{}, {Origin:'https://untrusted.example'})).status,403);
  });
  await t.test('independent identities register and accept versioned rules',async()=>{
    [A,B,C,D]=await Promise.all(['A · Coordinator','B · Research','C · Reviewer','D · Isolated'].map(bot));
    const tools=await A.client.listTools();assert.equal(tools.tools.length,14);
    const guide=(await call(A,'get_guide')).data;assert.equal(guide.self.id,A.agent.id);assert.match(guide.guide,/Markdown/);assert.match(guide.guide,/BotConcourse/);assert.match(guide.guide,/Register|register/);const zhGuide=(await call(A,'get_guide',{language:'zh'})).data;assert.match(zhGuide.guide,/机器人/);assert.equal(zhGuide.rules_version,guide.rules_version);
    const failed=await write(A,'create_thread',{group_id:'x',title:'Before registration',body:'Not allowed',to_ids:['all']},true);assert.equal(failed.data.error.code,'REGISTRATION_REQUIRED');
    for(const b of[A,B,C,D]){await write(b,'register_agent',{capabilities:['scenario-test','Markdown']});}
    group=await admin('group.create',{name:'Verification · '+new Date().toISOString(),description:'Simulated agents. No external actions or real platform messages.'});otherGroup=await admin('group.create',{name:'Isolated verification'});
    await admin('group.members',{id:group.id,members:[A.agent.id,B.agent.id,C.agent.id]});await admin('group.members',{id:otherGroup.id,members:[D.agent.id]});
  });
  await t.test('A → B message, B → A linked Markdown reply, and incremental directory',async()=>{
    const th=await topic(A,'1 · One-to-one conversation',[B.agent.id]);const reply=await write(B,'post_message',{thread_id:th.thread.id,reply_to_message_id:th.message.id,to_ids:[A.agent.id],kind:'reply',body:'# Response\n\n| Item | Status |\n| --- | --- |\n| Message | Received |\n\n```json\n{"ok":true}\n```'});assert.equal(reply.data.message.reply_to_message_id,th.message.id);
    const inbox=(await call(A,'list_directory',{after_seq:0,limit:1})).data;assert.equal(inbox.entries.length,1);assert.ok(!('body'in inbox.entries[0]));assert.ok(inbox.entries[0].created_at.match(/T\d\d:\d\d:\d\d/));const next=(await call(A,'list_directory',{after_seq:inbox.next_after_seq})).data;assert.ok(next.entries.every(x=>x.seq>inbox.next_after_seq));
    const wrong=(await call(D,'read_thread',{thread_id:th.thread.id},true));assert.equal(wrong.data.error.code,'FORBIDDEN');const d=(await call(D,'list_directory',{inbox_only:false})).data;assert.equal(d.entries.length,0);
    const job=await task(A,th.thread.id,[B.agent.id]);await error(C,'claim_task',{task_id:job.task.id,expected_version:1},'FORBIDDEN');
    const claimed=(await write(B,'claim_task',{task_id:job.task.id,expected_version:1})).data;await error(B,'update_task',{task_id:job.task.id,expected_version:claimed.task.version,action:'submit',lease_token:'wrong',body:'bad'},'LEASE_EXPIRED');
    const submitted=(await write(B,'update_task',{task_id:job.task.id,expected_version:claimed.task.version,action:'submit',lease_token:claimed.lease_token,body:'## Completed\nThe requested result.'})).data;
    await error(B,'update_task',{task_id:job.task.id,expected_version:submitted.task.version,action:'accept'},'FORBIDDEN');
    await write(A,'update_task',{task_id:job.task.id,expected_version:submitted.task.version,action:'accept',body:'Accepted'});await write(A,'close_thread',{thread_id:th.thread.id,summary:'One-to-one work completed and accepted.'});await error(B,'post_message',{thread_id:th.thread.id,to_ids:[A.agent.id],body:'No more replies'},'THREAD_STOPPED');
    const read=(await call(A,'read_thread',{thread_id:th.thread.id})).data;assert.equal(read.thread.status,'closed');assert.equal(read.tasks[0].status,'completed');assert.ok(read.messages.some(m=>m.body.includes('```json')));
  });
  await t.test('one-to-many assignment and many-to-one aggregate feedback',async()=>{
    const th=await topic(A,'2 · Parallel work and aggregate feedback',['all']);const jobs=await task(A,th.thread.id,[B.agent.id,C.agent.id]);assert.equal(jobs.children.length,2);assert.equal(jobs.task.status,'waiting_children');
    const detail=(await call(B,'get_task',{task_id:jobs.task.id})).data;assert.equal(detail.children.length,2);
    for(const [i,b]of[B,C].entries())await finish(b,A,jobs.children[i]);
    const aggregate=(await call(A,'get_task',{task_id:jobs.task.id})).data.task;assert.equal(aggregate.status,'awaiting_review');assert.ok(aggregate.result.includes(B.agent.id));await write(A,'update_task',{task_id:aggregate.id,expected_version:aggregate.version,action:'accept',body:'Both independent results reviewed.'});await write(A,'close_thread',{thread_id:th.thread.id,summary:'Both branches completed.'});
  });
  await t.test('many-to-many discussion and multiple issuers → one executor',async()=>{
    const th=await topic(B,'3 · Many-to-many coordination',['all']);await write(A,'post_message',{thread_id:th.thread.id,to_ids:[B.agent.id,C.agent.id],body:'## A → B,C\nShared plan.'});await write(C,'post_message',{thread_id:th.thread.id,to_ids:[A.agent.id,B.agent.id],body:'## C → A,B\nShared review.'});
    const j1=await task(A,th.thread.id,[C.agent.id],'A requests review');const j2=await task(B,th.thread.id,[C.agent.id],'B requests verification');await finish(C,A,j1.task);await finish(C,B,j2.task);await write(B,'close_thread',{thread_id:th.thread.id,summary:'Multiple issuers received separate feedback from C.'});
  });
  await t.test('idempotency prevents duplicate sends; conflicting reuse is rejected',async()=>{
    const th=await topic(C,'4 · Retry and concurrency',[A.agent.id]);const args={thread_id:th.thread.id,to_ids:[A.agent.id],body:'Retry-safe message',idempotency_key:uuid(),rules_version:rules};const first=(await call(C,'post_message',args)).data;const same=(await call(C,'post_message',args)).data;assert.equal(same.message.id,first.message.id);const bad=await call(C,'post_message',{...args,body:'Changed body'},true);assert.equal(bad.data.error.code,'IDEMPOTENCY_CONFLICT');
    const job=await task(C,th.thread.id,[B.agent.id]);const claims=await Promise.all([write(B,'claim_task',{task_id:job.task.id,expected_version:1},true),write(B,'claim_task',{task_id:job.task.id,expected_version:1},true)]);assert.equal(claims.filter(r=>!r.isError).length,1);assert.equal(claims.find(r=>r.isError).data.error.code,'CONFLICT');
    await admin('thread.control',{id:th.thread.id,action:'close',reason:'Concurrency scenario complete'});
  });
  await t.test('bounded clarification and rework; leases require current version',async()=>{
    const th=await topic(B,'5 · Clarifications and rework',[C.agent.id]);const job=await task(B,th.thread.id,[C.agent.id]);let claimed=(await write(C,'claim_task',{task_id:job.task.id,expected_version:1})).data;let v=claimed.task.version;
    for(let i=0;i<2;i++){const q=(await write(C,'update_task',{task_id:job.task.id,expected_version:v,lease_token:claimed.lease_token,action:'need_input',body:'Clarification '+i})).data;const resume=(await write(C,'update_task',{task_id:job.task.id,expected_version:q.task.version,lease_token:claimed.lease_token,action:'resume'})).data;v=resume.task.version;}
    await error(C,'update_task',{task_id:job.task.id,expected_version:v,lease_token:claimed.lease_token,action:'need_input',body:'Third question'},'LIMIT_REACHED');let submitted=(await write(C,'update_task',{task_id:job.task.id,expected_version:v,lease_token:claimed.lease_token,action:'submit',body:'First result'})).data;let rework=(await write(B,'update_task',{task_id:job.task.id,expected_version:submitted.task.version,action:'request_changes',body:'Make one correction'})).data;claimed=(await write(C,'claim_task',{task_id:job.task.id,expected_version:rework.task.version})).data;submitted=(await write(C,'update_task',{task_id:job.task.id,expected_version:claimed.task.version,lease_token:claimed.lease_token,action:'submit',body:'Corrected result'})).data;await error(B,'update_task',{task_id:job.task.id,expected_version:submitted.task.version,action:'request_changes',body:'Another round'},'LIMIT_REACHED');await write(B,'update_task',{task_id:job.task.id,expected_version:submitted.task.version,action:'accept',body:'Approved'});await write(B,'close_thread',{thread_id:th.thread.id,summary:'Rework bound verified.'});
  });
  await t.test('markdown source survives storage; export excludes credentials',async()=>{
    const th=await topic(A,'6 · Markdown rendering and visibility',['all']);const md='## Markdown sample\n\n- **Bold item**\n- *Italic item*\n\n> A quoted result\n\n| Agent | Result |\n| --- | --- |\n| A | Ready |\n\n```js\nconsole.log("safe code");\n```\n\n<script>window.pwned=1</script>\n<img src="https://example.invalid/tracker" onerror="window.pwned=1">\n[Unsafe](javascript:alert(1))';await write(A,'post_message',{thread_id:th.thread.id,to_ids:['all'],body:md});const r=(await call(B,'read_thread',{thread_id:th.thread.id})).data;assert.equal(r.messages.at(-1).body,md);
    const exp=await admin('export');const raw=JSON.stringify(exp);assert.ok(!raw.includes('lease_token'));assert.ok(!raw.includes(credentials.password));for(const k of issued)assert.ok(!raw.includes(k.key));
  });
  await t.test('read-only scopes, revoked keys, and removed membership fail closed',async()=>{
    const readKey=await admin('key.create',{agent_id:A.agent.id,scopes:['read']});issued.push(readKey);const init={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'legacy-test',version:'1'}}};const legacy=await fetch(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+readKey.key,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify(init)});assert.equal(legacy.status,200);
    const rawCall={jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'register_agent',arguments:{idempotency_key:uuid(),rules_version:rules,capabilities:[]}}};const denied=await fetch(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+readKey.key,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify(rawCall)});const txt=await denied.text();assert.match(txt,/FORBIDDEN/);await admin('key.revoke',{id:readKey.id});assert.equal((await fetch(base+'/mcp',{headers:{Authorization:'Bearer '+readKey.key}})).status,401);
    await admin('group.members',{id:otherGroup.id,members:[]});const guides=(await call(D,'get_guide')).data;assert.equal(guides.groups.length,0);
  });
  await t.test('hard message cap stops agent loops and only admin can resume',async()=>{
    const loopBots=await Promise.all(['E · Budget test','F · Budget test','G · Budget test'].map(bot));for(const b of loopBots)await write(b,'register_agent',{capabilities:['test']});await admin('group.members',{id:group.id,members:[A.agent.id,B.agent.id,C.agent.id,...loopBots.map(b=>b.agent.id)]});const th=await topic(loopBots[0],'7 · Hard stop at 40 agent messages',['all']);for(let i=0;i<39;i++)await write(loopBots[i%3],'post_message',{thread_id:th.thread.id,to_ids:['all'],body:'Bounded message '+i});const final=(await call(loopBots[0],'read_thread',{thread_id:th.thread.id})).data;assert.equal(final.thread.status,'needs_human');assert.equal(final.thread.message_count,40);await error(loopBots[1],'post_message',{thread_id:th.thread.id,to_ids:['all'],body:'Must stop'},'THREAD_STOPPED');await admin('thread.control',{id:th.thread.id,action:'resume',reason:'Verify controlled resume'});const resumed=(await call(loopBots[0],'read_thread',{thread_id:th.thread.id})).data;assert.equal(resumed.thread.max_messages,60);await admin('thread.control',{id:th.thread.id,action:'close',reason:'Budget scenario complete'});const reopen=await http('/api/thread.control',{id:th.thread.id,action:'pause'});assert.equal(reopen.status,409);
  });
  await t.test('admin directory paginates, searches and filters without reading message bodies',async()=>{
    const first=await admin('threads?group_id='+group.id+'&limit=2');assert.equal(first.threads.length,2);assert.equal(first.has_more,true);assert.equal(first.next_offset,2);const second=await admin('threads?group_id='+group.id+'&limit=2&offset='+first.next_offset);assert.ok(second.threads.every(x=>!first.threads.some(y=>x.id===y.id)));assert.ok(first.threads.every(x=>!('messages'in x)&&!('body'in x)));const filtered=await admin('threads?group_id='+group.id+'&status=closed&q='+encodeURIComponent('One-to-one'));assert.equal(filtered.threads.length,1);assert.equal(filtered.threads[0].title,'1 · One-to-one conversation');assert.equal((await http('/api/threads?limit=-1')).status,400);
  });
  await t.test('test cleanup revokes all simulated identities, retains audit evidence',async()=>{
    for(const a of agents)await admin('agent.disable',{id:a.id});for(const id of threads)await admin('thread.control',{id,action:'close',reason:'Verification complete. Simulated agents disabled.'});const audit=await admin('audit');assert.ok(audit.some(x=>x.action==='agent.disable'));const deniedKey=await http('/api/key.create',{agent_id:agents[0].id});assert.equal(deniedKey.status,403);assert.equal((await deniedKey.json()).error.code,'FORBIDDEN');for(const c of clients)await c.close();
    const report={target:base,finished_at:new Date().toISOString(),group_id:group.id,simulated_agents:agents.length,topics:threads.length,real_platform_accounts_connected:false};fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/latest-'+(base.startsWith('https')?'production':'local')+'.json',JSON.stringify(report,null,2));
  });
});
