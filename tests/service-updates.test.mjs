import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
const base=process.env.BC_TEST_URL||'http://127.0.0.1:8787';
test('Permanent upgrade bootstrap: every tool path, compact acknowledgements, safe retry',async()=>{
 const access=JSON.parse(fs.readFileSync(process.env.BC_ACCESS_FILE||'docs/private/admin-access.json'));
 const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(access)});assert.equal(login.status,200);
 const {csrf}=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0];
 async function admin(name,args){const r=await fetch(base+'/api/'+name,{method:args?'POST':'GET',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json','X-CSRF-Token':csrf},body:args?JSON.stringify(args):undefined});const j=await r.json();assert.equal(r.status,200,JSON.stringify(j));return j;}
 const bot=await admin('agent.create',{platform:'测试',name:'Upgrade fixture'}),key=await admin('key.create',{agent_id:bot.id});const client=new Client({name:'old-host-upgrade-fixture',version:'1.1'});
 await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+key.key}}}));
 async function call(name,args){const r=await client.callTool({name,arguments:args});return {r,j:r.structuredContent||JSON.parse(r.content[0].text)};}
 try{
  assert.match(client.getInstructions(),/UPDATE REQUIRED/);
  const legacy=await call('get_guide',{include_guide:false,known_rules_version:'2026-11-13.3'});assert.ok(legacy.j.guide);assert.equal(legacy.j.service_notice.code,'RULES_UPDATE_REQUIRED');const rules=legacy.j.rules_version;
  const read=await call('list_my_tasks',{});assert.equal(read.j.service_notice.rules_version,rules);
  const denied=await call('create_thread',{group_id:'nonexistent',title:'Must not write',body:'No action',to_ids:['all'],rules_version:'2026-11-13.3',idempotency_key:crypto.randomUUID()});assert.equal(denied.j.error.code,'RULES_UPDATE_REQUIRED');assert.equal(denied.j.error.service_notice.action,'get_guide');
  const legacyRegister=await call('register_agent',{rules_version:'2026-11-13.3',idempotency_key:crypto.randomUUID()});assert.equal(legacyRegister.j.error.code,'RULES_UPDATE_REQUIRED');
  const unseen=await call('get_task',{task_id:'not-a-task'});assert.ok(unseen.r.isError);assert.equal(unseen.j.error.service_notice.rules_version,rules);
  const args={rules_version:rules,idempotency_key:crypto.randomUUID(),capabilities:['Keep these capabilities']};const registered=await call('register_agent',args);assert.ok(!registered.r.isError);assert.ok(!registered.j.service_notice);
  const replay=await call('register_agent',args);assert.deepEqual(replay.j.self.capabilities,args.capabilities);assert.ok(!replay.j.service_notice);
  const unchanged=await call('get_guide',{known_rules_version:rules,include_guide:false});assert.equal(unchanged.j.changed,false);assert.ok(!unchanged.j.guide);assert.ok(!unchanged.j.service_notice);
  const staleWrite=await call('create_thread',{group_id:'nonexistent',title:'Old persisted schedule',body:'Stop',to_ids:['all'],rules_version:'2026-11-13.3',idempotency_key:crypto.randomUUID()});assert.equal(staleWrite.j.error.code,'RULES_UPDATE_REQUIRED');assert.equal(staleWrite.j.error.service_notice.rules_version,rules);
  const healthy=await fetch(base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+key.key,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/list'})});assert.equal(healthy.headers.get('BotConcourse-Rules-Version'),rules);assert.equal(healthy.headers.get('BotConcourse-Update-Required'),'false');
 }finally{await admin('key.revoke',{id:key.id});await admin('agent.disable',{id:bot.id});await client.close();}
});
