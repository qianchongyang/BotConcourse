import { DurableObject } from 'cloudflare:workers';
import bcrypt from 'bcryptjs';
import { GUIDE_EN } from './guide-en';
import { AppError, requireThat as must, now, newId, randomToken, sha256, constantEqual, canonical, schemas, GUIDE, LIMITS, RULES_VERSION, VERSION, POLLING, type Op } from './protocol';

export interface Env { WORKSPACE: DurableObjectNamespace<Workspace>; ASSETS: Fetcher; ADMIN_USERNAME:string; ADMIN_PASSWORD_HASH:string; APP_ORIGIN:string; ENVIRONMENT:string; }
type Actor = { id:string; admin:boolean; scopes:string[]; key_id?:string; rules_version?:string };
type Row = Record<string,any>;
const terminal = new Set(['completed','cancelled','failed','declined','expired']);
export class Workspace extends DurableObject<Env> {
  sql: SqlStorage;
  constructor(ctx:DurableObjectState,env:Env) {
    super(ctx,env); this.sql=ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,group_id TEXT,thread_id TEXT,parent_id TEXT,status TEXT,data TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE INDEX IF NOT EXISTS records_group ON records(kind,group_id,updated_at); CREATE INDEX IF NOT EXISTS records_thread ON records(kind,thread_id); CREATE INDEX IF NOT EXISTS records_parent ON records(kind,parent_id); CREATE INDEX IF NOT EXISTS records_status ON records(kind,status); CREATE TABLE IF NOT EXISTS members(group_id TEXT,agent_id TEXT,PRIMARY KEY(group_id,agent_id)); CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,hash TEXT NOT NULL,scopes TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT,revoked INTEGER NOT NULL DEFAULT 0,last_used TEXT); CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires_at INTEGER NOT NULL,password_version TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,group_id TEXT,thread_id TEXT,task_id TEXT,kind TEXT,from_id TEXT,to_ids TEXT,title TEXT,summary TEXT,created_at TEXT,data TEXT); CREATE INDEX IF NOT EXISTS events_group ON events(group_id,seq); CREATE INDEX IF NOT EXISTS events_thread ON events(thread_id,seq); CREATE TABLE IF NOT EXISTS audience(seq INTEGER,agent_id TEXT,needs_action INTEGER,PRIMARY KEY(agent_id,seq)); CREATE TABLE IF NOT EXISTS idempotency(actor_id TEXT,key TEXT,operation TEXT,hash TEXT,result TEXT,created_at TEXT,PRIMARY KEY(actor_id,key)); CREATE TABLE IF NOT EXISTS rates(id TEXT PRIMARY KEY,count INTEGER,reset_at INTEGER); CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,actor_id TEXT,action TEXT,target_id TEXT,created_at TEXT,details TEXT);');
  }
  async rpc(method:string,args:any[]):Promise<any> {
    const started=Date.now(),trace=newId('trace');
    try {const allowed=['authenticateKey','login','session','logout','call','admin'];must(allowed.includes(method),'NOT_FOUND','Unknown operation',404);const value=await (this as any)[method](...args);const notice=method==='call'?this.serviceNotice(args[0]):undefined;return {ok:true,value:notice?{...value,service_notice:notice}:value};}
    catch(error){const e=error instanceof AppError?error:new AppError('INTERNAL','Internal service error',500);if(['call','admin'].includes(method)&&args[0]?.id){try{this.audit(args[0],'operation.error',trace,{operation:typeof args[1]==='string'?args[1].slice(0,80):method,code:e.code,status:e.status,duration_ms:Date.now()-started,version:VERSION,thread_id:typeof args[2]?.thread_id==='string'?args[2].thread_id:undefined,task_id:typeof args[2]?.task_id==='string'?args[2].task_id:undefined});}catch{}}const notice=method==='call'&&args[0]?.id?this.serviceNotice(args[0],e.code==='RULES_UPDATE_REQUIRED'):undefined;return {ok:false,error:{code:e.code,message:e.message,status:e.status,trace_id:trace,...e.details?{details:e.details}:{},...notice?{service_notice:notice}:{}}};}
  }

  serviceNotice(actor:Actor,force=false) {
    if(actor.admin)return undefined;
    const accepted=this.get('agent',actor.id).rules_version;
    if(accepted===RULES_VERSION&&!force)return undefined;
    return {code:'RULES_UPDATE_REQUIRED',version:VERSION,rules_version:RULES_VERSION,accepted_rules_version:accepted||null,action:'get_guide',arguments:{include_guide:true},message:'The service rules changed or have not been accepted. Read the full get_guide, refresh your saved host routine instructions, then register_agent with the returned rules_version and your existing capabilities. Preserve cursors and task state. Do not repeat completed external actions.',can_register:actor.scopes.includes('write')};
  }
  logout(hash:string) {this.sql.exec('DELETE FROM sessions WHERE hash=?',hash);return {ok:true};}
  rows(query:string,...args:any[]):Row[] { return Array.from(this.sql.exec(query,...args)) as Row[]; }
  get(kind:string,id:string):Row { const r=this.rows('SELECT data FROM records WHERE kind=? AND id=?',kind,id)[0]; must(r,'NOT_FOUND','记录不存在或无权访问',404); const value=JSON.parse(r.data);return kind==='agent'?this.agentProfile(value):value; }
  agentProfile(value:Row):Row {const branded=['Muse','Grok Bot','ChatGPT dots'].includes(value.platform);return {...value,alias:value.alias??(branded&&value.name!==value.platform&&!value.name.startsWith(value.platform+' · ')?value.name:''),name:branded?value.platform+' · '+value.id.slice(-8):value.name};}
  checkpoint() {const seq=this.rows("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='events'),0) seq")[0].seq;return {after_seq:seq,server_time:now()};}

  taskQuery(actor:Actor,groupId?:string,actionable=true) {
    const time=now(),args:any[]=[time,time];
    let query="SELECT r.data FROM records r JOIN records t ON t.kind='thread' AND t.id=r.thread_id JOIN records g ON g.kind='group' AND g.id=r.group_id WHERE r.kind='task' AND r.status IN ('assigned','in_progress','waiting_input','awaiting_review','waiting_children','needs_human') AND t.status='open' AND g.status='active' AND COALESCE(json_extract(r.data,'$.start_at'),json_extract(r.data,'$.created_at'))<=? AND json_extract(r.data,'$.due_at')>?";
    if(!actor.admin){query+=" AND EXISTS(SELECT 1 FROM members m WHERE m.group_id=r.group_id AND m.agent_id=?) AND (json_extract(r.data,'$.assignee_id')=? OR json_extract(r.data,'$.created_by')=?)";args.push(actor.id,actor.id,actor.id);}
    if(groupId){query+=' AND r.group_id=?';args.push(groupId);}
    if(actionable){query+=" AND ((r.status IN ('assigned','in_progress') AND json_extract(r.data,'$.assignee_id')=?) OR (r.status='awaiting_review' AND (?=1 OR json_extract(r.data,'$.created_by')=?)))";args.push(actor.id,actor.admin?1:0,actor.id);}
    return {query,args};
  }
  async rosterVersion(groupId:string) {
    const g=this.get('group',groupId),members=this.members(groupId).sort().map(id=>{const m=this.get('agent',id);return {id:m.id,name:m.name,alias:m.alias||'',platform:m.platform,status:m.status,capabilities:m.capabilities};});
    return {members,version:await sha256(canonical({status:g.status,members}))};
  }
  async checkUpdates(actor:Actor,a:any) {
    const all=this.groups(actor).sort((x,y)=>x.id.localeCompare(y.id));
    if(a.group_ids)for(const id of a.group_ids)this.group(actor,id);
    const groupsVersion=await sha256(canonical(all.map(g=>({id:g.id,name:g.name,status:g.status}))));
    const selected=all.filter(g=>(!a.group_ids||a.group_ids.includes(g.id))&&g.id>a.group_after),page=selected.slice(0,a.limit);
    const groups=[];
    for(const g of page){
      const after=a.checkpoints.find((c:any)=>c.group_id===g.id)?.after_seq??a.since_seq;
      must(after<=this.checkpoint().after_seq,'VALIDATION','检查游标超出当前序号');
      const rows=this.rows("SELECT COALESCE(MAX(e.seq),0) latest_seq,COALESCE(MAX(CASE WHEN e.seq>? AND e.from_id<>? AND (?=1 OR EXISTS(SELECT 1 FROM audience a WHERE a.seq=e.seq AND a.agent_id=?)) THEN 1 ELSE 0 END),0) changed FROM events e WHERE e.group_id=?",after,actor.id,actor.admin?1:0,actor.id,g.id);
      const q=this.taskQuery(actor,g.id),pending=this.rows('SELECT COUNT(*) n FROM ('+q.query+')',...q.args)[0].n;
      const pendingReplies=this.rows("SELECT COUNT(*) n FROM events e JOIN audience a ON a.seq=e.seq JOIN records t ON t.kind='thread' AND t.id=e.thread_id WHERE e.group_id=? AND t.status='open' AND a.agent_id=? AND a.needs_action=1 AND e.from_id<>? AND e.kind IN ('opening','question','reply','note','progress') AND NOT EXISTS(SELECT 1 FROM events r WHERE r.thread_id=e.thread_id AND json_extract(r.data,'$.reply_to_message_id')=e.id AND r.from_id=a.agent_id)",g.id,actor.id,actor.id)[0].n;
      const roster=await this.rosterVersion(g.id);
      groups.push({id:g.id,latest_seq:rows[0].latest_seq,has_new_events:!!rows[0].changed,pending_count:pending,pending_reply_count:g.status==='active'?pendingReplies:0,members_version:roster.version,members_changed:a.known_members_versions[g.id]!==roster.version});
    }
    const rulesChanged=a.known_rules_version!==RULES_VERSION,groupsChanged=a.known_groups_version!==groupsVersion;
    const registrationRequired=!actor.admin&&this.get('agent',actor.id).rules_version!==RULES_VERSION;
    const hasMore=selected.length>a.limit;
    return {has_updates:rulesChanged||groupsChanged||registrationRequired||hasMore||groups.some(g=>g.has_new_events||g.pending_count>0||g.pending_reply_count>0||g.members_changed),rules_changed:rulesChanged,registration_required:registrationRequired,groups_changed:groupsChanged,rules_version:RULES_VERSION,groups_version:groupsVersion,groups,has_more:hasMore,next_group_after:hasMore?page.at(-1)!.id:'',server_time:now(),retry_after_seconds:POLLING.interval_seconds};
  }
  threadWaiting(t:Row) {
    if(t.status!=='open'||this.get('group',t.group_id).status!=='active')return {state:t.status==='closed'?'closed':'paused',items:[],has_more:false};
    const items:Row[]=[];
    for(const r of this.rows("SELECT data FROM records WHERE kind='task' AND thread_id=? AND status NOT IN ('completed','cancelled','failed','declined','expired')",t.id)){
      const task=JSON.parse(r.data);
      const who=task.status==='awaiting_review'?task.created_by:task.status==='waiting_children'?null:task.status==='waiting_input'?task.created_by:task.assignee_id;
      items.push({type:'task',task_id:task.id,actor_id:who,status:task.status,start_at:task.start_at||task.created_at,due_at:task.due_at});
    }
    const unanswered=this.rows("SELECT e.id,e.task_id,e.created_at,a.agent_id FROM events e JOIN audience a ON a.seq=e.seq JOIN members m ON m.group_id=e.group_id AND m.agent_id=a.agent_id WHERE e.thread_id=? AND a.needs_action=1 AND e.kind IN ('opening','question','reply','note','progress') AND a.agent_id<>e.from_id AND NOT EXISTS(SELECT 1 FROM events r WHERE r.thread_id=e.thread_id AND json_extract(r.data,'$.reply_to_message_id')=e.id AND r.from_id=a.agent_id) ORDER BY e.seq LIMIT 21",t.id);
    for(const m of unanswered)items.push({type:'reply',message_id:m.id,task_id:m.task_id,actor_id:m.agent_id,created_at:m.created_at});
    if(!items.length)items.push({type:'close',actor_id:t.created_by});
    return {state:items[0].type==='close'?'ready_to_close':'waiting',items:items.slice(0,20),has_more:items.length>20};
  }
  async recordRead(actor:Actor,operation:Op,a:any,result:any) {
    if(actor.admin||!['check_updates','list_directory','list_my_tasks','read_thread'].includes(operation))return;
    const key='monitor:'+actor.id;
    const history=await this.ctx.storage.get<Row[]>(key)||[];
    history.push({operation,at:now(),group_id:a.group_id,thread_id:a.thread_id,after_seq:a.after_seq??a.since_seq,until_seq:result.window?.until_seq,next_after_seq:result.next_after_seq,after_task_id:a.after_task_id,next_after_task_id:result.next_after_task_id,checkpoints:a.checkpoints,group_after:a.group_after,has_more:result.has_more,has_updates:result.has_updates,count:result.entries?.length??result.tasks?.length??result.messages?.length,groups:result.groups?.map((g:any)=>({id:g.id,has_new_events:g.has_new_events,pending_count:g.pending_count,pending_reply_count:g.pending_reply_count})),version:VERSION});
    await this.ctx.storage.put(key,history.slice(-20));
    if(operation==='check_updates')await this.ctx.storage.put('last-check:'+actor.id,history.at(-1)!);
  }
  put(kind:string,value:Row) { value.updated_at=now(); this.sql.exec('INSERT INTO records(kind,id,group_id,thread_id,parent_id,status,data,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET group_id=excluded.group_id,thread_id=excluded.thread_id,parent_id=excluded.parent_id,status=excluded.status,data=excluded.data,updated_at=excluded.updated_at',kind,value.id,value.group_id||null,value.thread_id||null,value.parent_id||null,value.status||null,JSON.stringify(value),value.updated_at); }
  audit(actor:Actor,action:string,target:string,details:Row={}) { this.sql.exec('INSERT INTO audit VALUES(?,?,?,?,?,?)',newId('audit'),actor.id,action,target,now(),JSON.stringify(details)); }
  rate(id:string,max:number,seconds=60) { const t=Date.now();const r=this.rows('SELECT * FROM rates WHERE id=?',id)[0]; if(!r||r.reset_at<t) this.sql.exec('INSERT OR REPLACE INTO rates VALUES(?,1,?)',id,t+seconds*1000); else {must(r.count<max,'RATE_LIMITED','请求过于频繁，请稍后重试',429);this.sql.exec('UPDATE rates SET count=count+1 WHERE id=?',id);} }
  group(actor:Actor,id:string):Row {const g=this.get('group',id);must(actor.admin||this.rows('SELECT 1 FROM members WHERE group_id=? AND agent_id=?',id,actor.id).length,'FORBIDDEN','没有该群组的访问权限',403);return g;}
  topic(actor:Actor,id:string,write=false):Row {const t=this.get('thread',id);const g=this.group(actor,t.group_id);if(write){must(g.status==='active','GROUP_PAUSED','该群组已暂停',409);must(t.status==='open','THREAD_STOPPED','主题已停止，需要管理员处理',409);}return t;}
  task(actor:Actor,id:string):Row {const t=this.get('task',id);this.group(actor,t.group_id);return t;}
  publicTask(task:Row):Row {const {lease_token,...value}=task;return value;}
  members(group:string):string[] {return this.rows('SELECT agent_id FROM members WHERE group_id=?',group).map(r=>r.agent_id);}
  resolveTo(actor:Actor,group:string,ids:string[]):string[] {const members=this.members(group);const to=[...new Set(ids.includes('all')?members:ids)];must(to.length<=20,'VALIDATION','收件人过多');for(const id of to)must(id==='admin'||members.includes(id),'INVALID_RECIPIENT','收件人不在此群组');return to.filter(id=>id!==actor.id);}
  event(actor:Actor,t:Row,kind:string,body:string,to:string[],action=false,taskId?:string,reply?:string):Row {
    must(new TextEncoder().encode(body).length<=LIMITS.maxMessageBytes,'PAYLOAD_TOO_LARGE','正文不能超过 16 KB',413);
    const id=newId('msg'),created=now();const payload={id,thread_id:t.id,group_id:t.group_id,task_id:taskId||null,from_id:actor.id,to_ids:to,kind,body,expects_reply:action,reply_to_message_id:reply||null,created_at:created};
    const seq=this.rows('INSERT INTO events(id,group_id,thread_id,task_id,kind,from_id,to_ids,title,summary,created_at,data) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING seq',id,t.group_id,t.id,taskId||null,kind,actor.id,JSON.stringify(to),t.title,body.slice(0,140),created,JSON.stringify(payload))[0].seq;
    for(const recipient of to) this.sql.exec('INSERT INTO audience VALUES(?,?,?)',seq,recipient,action?1:0);
    t.last_seq=seq;t.last_activity_at=created;this.put('thread',t);return {...payload,seq,...kind==='task_submit'?{body:'任务成果已提交，请按需调用 get_task 读取。',result_ref:{tool:'get_task',task_id:taskId}}:{}};
  }
  reserveMessage(actor:Actor,t:Row) {if(actor.admin)return;must(t.message_count<t.max_messages,'LIMIT_REACHED','主题已达到交流上限，等待管理员处理',409);t.message_count++;this.put('thread',t);}
  stopAtLimit(t:Row) {if(t.message_count>=t.max_messages&&t.status==='open'){t.status='needs_human';this.put('thread',t);this.event({id:'system',admin:true,scopes:[]},t,'system','达到主题消息上限，已暂停机器人继续交流。',['admin']);}}
  async authenticateKey(raw:string,ip:string):Promise<Actor> {
    must(raw&&raw.length<250,'UNAUTHORIZED','需要有效 API Key',401);
    const parts=raw.split('.');must(parts.length===3&&parts[0]==='bc','UNAUTHORIZED','需要有效 API Key',401);
    const row=this.rows('SELECT * FROM api_keys WHERE id=?',parts[1])[0];const hash=await sha256(raw);
    if(!row||row.revoked||!constantEqual(row.hash,hash)||(row.expires_at&&row.expires_at<=now())){this.rate('badkey:'+ip,30);throw new AppError('UNAUTHORIZED','API Key 无效、过期或已撤销',401);}
    const agent=this.get('agent',row.agent_id);must(agent.status!=='disabled','UNAUTHORIZED','机器人已停用',401);this.rate('key:'+row.id,120);
    if(!row.last_used||Date.now()-Date.parse(row.last_used)>60000)this.sql.exec('UPDATE api_keys SET last_used=? WHERE id=?',now(),row.id);
    return {id:row.agent_id,admin:false,scopes:JSON.parse(row.scopes),key_id:row.id,rules_version:agent.rules_version};
  }
  async login(username:string,password:string,ip:string) {
    this.rate('login:'+ip,8,900);this.rate('login-global',60,900);
    must(typeof username==='string'&&typeof password==='string'&&password.length<=72,'UNAUTHORIZED','账号或密码错误',401);
    must(this.env.ADMIN_PASSWORD_HASH?.startsWith('$2'),'NOT_CONFIGURED','管理员密码尚未配置',503);
    const match=await bcrypt.compare(password,this.env.ADMIN_PASSWORD_HASH);
    must(match&&constantEqual(username,this.env.ADMIN_USERNAME),'UNAUTHORIZED','账号或密码错误',401);
    const token=randomToken(),csrf=randomToken();const hash=await sha256(token);
    this.sql.exec('INSERT INTO sessions VALUES(?,?,?,?)',hash,csrf,Date.now()+8*3600000,this.env.ADMIN_PASSWORD_HASH);
    this.audit({id:'admin',admin:true,scopes:[]},'login','admin');return {token,csrf};
  }
  async session(token:string,csrf?:string,write=false) {
    must(token&&token.length<200,'UNAUTHORIZED','请先登录',401);const hash=await sha256(token);const s=this.rows('SELECT * FROM sessions WHERE hash=?',hash)[0];
    must(s&&s.expires_at>Date.now()&&s.password_version===this.env.ADMIN_PASSWORD_HASH,'UNAUTHORIZED','登录已过期',401);
    if(write)must(csrf&&constantEqual(csrf,s.csrf),'CSRF','请求校验失败，请刷新页面',403);
    return {hash,csrf:s.csrf,actor:{id:'admin',admin:true,scopes:['read','write','task']} as Actor};
  }
  async issueKey(actor:Actor,agentId:string,days=90,scopes=['read','write','task']) {
    must(actor.admin,'FORBIDDEN','仅管理员可以创建密钥',403);must(this.get('agent',agentId).status!=='disabled','FORBIDDEN','Disabled agents cannot receive new keys',403);
    must(Number.isInteger(days)&&days>=1&&days<=365,'VALIDATION','有效期为 1 至 365 天');
    must(scopes.length>0&&scopes.every(s=>['read','write','task'].includes(s)),'VALIDATION','无效权限');
    const id=crypto.randomUUID(),key='bc.'+id+'.'+randomToken();const hash=await sha256(key);const expires=new Date(Date.now()+days*86400000).toISOString();
    this.sql.exec('INSERT INTO api_keys(id,agent_id,hash,scopes,created_at,expires_at) VALUES(?,?,?,?,?,?)',id,agentId,hash,JSON.stringify(scopes),now(),expires);
    this.audit(actor,'key.create',id,{agent_id:agentId,expires_at:expires});return {id,agent_id:agentId,key,expires_at:expires,notice:'完整密钥只显示一次，请存入机器人连接的安全配置中。'};
  }
  async call(actor:Actor,operation:Op,input:unknown) {
    const schema=schemas[operation];must(schema,'UNKNOWN_TOOL','未知工具');const parsed=schema.safeParse(input);must(parsed.success,'VALIDATION',parsed.success?'':parsed.error.issues.map(i=>i.path.join('.')+': '+i.message).join('; '));const a:any=parsed.data;
    const write='idempotency_key' in a;
    must(actor.admin||actor.scopes.includes(write?(operation.includes('task')?'task':'write'):'read'),'FORBIDDEN','此密钥没有该操作权限',403);
    if(!actor.admin){const key=this.rows('SELECT revoked,expires_at FROM api_keys WHERE id=? AND agent_id=?',actor.key_id,actor.id)[0];must(key&&!key.revoked&&(!key.expires_at||key.expires_at>now())&&this.get('agent',actor.id).status!=='disabled','UNAUTHORIZED','API Key is no longer valid',401);}
    if(write){must(a.rules_version===RULES_VERSION,'RULES_UPDATE_REQUIRED','Rules changed: call get_guide, read the full guide and register_agent with its current rules_version. Preserve cursors; do not blindly retry this write.',409);if(!actor.admin&&operation!=='register_agent')must(this.get('agent',actor.id).rules_version===RULES_VERSION,'REGISTRATION_REQUIRED','Read get_guide and register_agent to accept the current rules before writing',409);}
    this.sweep();
    if(!write){const result=await this.read(actor,operation,a);await this.recordRead(actor,operation,a,result);return result;}
    const hash=await sha256(canonical({operation,a}));
    return this.ctx.storage.transactionSync(()=>{
      const existing=this.rows('SELECT * FROM idempotency WHERE actor_id=? AND key=?',actor.id,a.idempotency_key)[0];
      if(existing){must(existing.operation===operation&&existing.hash===hash,'IDEMPOTENCY_CONFLICT','相同幂等键不能用于不同请求',409);return JSON.parse(existing.result);}
      this.rate('write:'+actor.id,30);
      const result=this.mutate(actor,operation,a);
      this.sql.exec('INSERT INTO idempotency VALUES(?,?,?,?,?,?)',actor.id,a.idempotency_key,operation,hash,JSON.stringify(result),now());
      this.audit(actor,operation,result.message?.id||result.id||result.task?.id||result.thread?.id||actor.id,{thread_id:result.message?.thread_id||result.task?.thread_id||result.thread?.id,task_id:result.task?.id||result.message?.task_id,message_id:result.message?.id});
      return result;
    });
  }
  async read(actor:Actor,op:Op,a:any):Promise<any> {
    if(op==='check_updates')return this.checkUpdates(actor,a);
    if(op==='get_guide')return {service:'BotConcourse MCP',version:VERSION,rules_version:RULES_VERSION,server_time:now(),self:actor.admin?{id:'admin',name:'管理员'}:this.get('agent',actor.id),groups:this.groups(actor).map(g=>({id:g.id,name:g.name,status:g.status})),polling:POLLING,directory_checkpoint:this.checkpoint(),limits:LIMITS,language:a.language,changed:a.known_rules_version!==RULES_VERSION,...(a.include_guide&&a.known_rules_version!==RULES_VERSION||!actor.admin&&this.get('agent',actor.id).rules_version!==RULES_VERSION)?{guide:a.language==='zh'?GUIDE:GUIDE_EN}:{}};
    if(op==='get_task'){const task=this.task(actor,a.task_id);return {task:this.publicTask(task),children:this.rows('SELECT data FROM records WHERE kind=? AND parent_id=?','task',task.id).map(r=>this.publicTask(JSON.parse(r.data))),server_time:now()};}
    if(op==='read_thread'){
      const thread=this.topic(actor,a.thread_id),rows=this.rows('SELECT seq,data FROM events WHERE thread_id=? AND seq>? ORDER BY seq LIMIT ?',thread.id,a.after_seq,a.limit+1),page=rows.slice(0,a.limit);
      const fullTasks=this.rows('SELECT data FROM records WHERE kind=? AND thread_id=? ORDER BY updated_at','task',thread.id).map(r=>this.publicTask(JSON.parse(r.data)));
      const tasks=fullTasks.map(t=>a.include_task_results?t:{id:t.id,title:t.title,status:t.status,version:t.version,assignee_id:t.assignee_id,created_by:t.created_by,parent_id:t.parent_id,group_id:t.group_id,thread_id:t.thread_id});
      const messages=page.map(r=>{
        const m={...JSON.parse(r.data),seq:r.seq},task=fullTasks.find(t=>t.id===m.task_id);
        if(m.kind==='task_submit'){m.result_ref={tool:'get_task',task_id:m.task_id};if(!a.include_task_results)m.body='任务成果已提交，请按需调用 get_task 读取。';}
        m.summary=m.body.slice(0,140);
        if(a.fields==='metadata'){delete m.body;delete m.summary;}
        else if(a.fields==='summary'){delete m.body;}
        else {m.truncated=m.body.length>a.max_body_chars;m.body=m.body.slice(0,a.max_body_chars);}
        return m;
      });
      return {thread,tasks,messages,waiting:this.threadWaiting(thread),has_more:rows.length>a.limit,next_after_seq:page.at(-1)?.seq||a.after_seq,server_time:now()};
    }
    if(op==='list_group_members'){
      const group=this.group(actor,a.group_id);
      const members=this.members(group.id).sort().map(id=>{const m=this.get('agent',id);return {id:m.id,name:m.name,alias:m.alias||'',platform:m.platform,status:m.status,capabilities:m.capabilities};});
      const version=await sha256(canonical({status:group.status,members}));
      return {group_id:group.id,group_name:group.name,group_status:group.status,self_id:actor.id,version,changed:version!==a.known_version,...version!==a.known_version?{members}:{},server_time:now()};
    }
    if(op==='list_my_tasks'){
      if(a.group_id)this.group(actor,a.group_id);
      const time=now(),q=this.taskQuery(actor,a.group_id,a.actionable_only),args=q.args;
      let query=q.query+' AND r.id>? ORDER BY r.id LIMIT ?';args.push(a.after_task_id,a.limit+1);
      const rows=this.rows(query,...args),page=rows.slice(0,a.limit).map(r=>JSON.parse(r.data));
      return {server_time:time,tasks:page.map(t=>({id:t.id,group_id:t.group_id,thread_id:t.thread_id,title:t.title,status:t.status,version:t.version,created_by:t.created_by,assignee_id:t.assignee_id,start_at:t.start_at||t.created_at,due_at:t.due_at,updated_at:t.updated_at,role:t.assignee_id===actor.id?'assignee':'issuer',actionable:(t.assignee_id===actor.id&&['assigned','in_progress'].includes(t.status))||(t.status==='awaiting_review'&&(actor.admin||t.created_by===actor.id))})),has_more:rows.length>a.limit,next_after_task_id:page.at(-1)?.id||a.after_task_id,scan_complete:rows.length<=a.limit};
    }
    if(op==='list_directory'){
      if(a.group_id)this.group(actor,a.group_id);
      const checkpoint=this.checkpoint(),until=a.until_seq??checkpoint.after_seq;
      must(until>=a.after_seq&&until<=checkpoint.after_seq,'VALIDATION','目录上限必须介于游标和当前序号之间');
      let query='SELECT e.seq,e.id,e.group_id,e.thread_id,e.task_id,e.kind,e.from_id,e.to_ids,e.title,e.summary,e.created_at FROM events e';const args:any[]=[];if(!actor.admin&&a.inbox_only){query+=' JOIN audience recipient ON recipient.seq=e.seq AND recipient.agent_id=?';args.push(actor.id);}query+=' WHERE e.seq>? AND e.seq<=?';args.push(a.after_seq,until);
      if(!actor.admin){query+=' AND EXISTS(SELECT 1 FROM members m WHERE m.group_id=e.group_id AND m.agent_id=?)';args.push(actor.id);}
      if(a.group_id){query+=' AND e.group_id=?';args.push(a.group_id);}query+=' ORDER BY e.seq LIMIT ?';args.push(a.limit+1);
      const rows=this.rows(query,...args),page=rows.slice(0,a.limit),hasMore=rows.length>a.limit;
      return {server_time:checkpoint.server_time,rules_version:RULES_VERSION,window:{after_seq:a.after_seq,until_seq:until,start_at:this.rows('SELECT created_at FROM events WHERE seq=?',a.after_seq)[0]?.created_at||null,end_at:this.rows('SELECT created_at FROM events WHERE seq=?',until)[0]?.created_at||checkpoint.server_time},entries:page.map(r=>({...r,to_ids:JSON.parse(r.to_ids),thread_status:this.get('thread',r.thread_id).status,task_status:r.task_id?this.get('task',r.task_id).status:null,needs_action:!actor.admin&&this.get('group',r.group_id).status==='active'&&this.get('thread',r.thread_id).status==='open'&&(!r.task_id||!terminal.has(this.get('task',r.task_id).status)||['note','reply','question'].includes(r.kind))&&!!this.rows('SELECT 1 FROM audience WHERE seq=? AND agent_id=? AND needs_action=1',r.seq,actor.id).length})),next_after_seq:hasMore?page.at(-1)!.seq:until,has_more:hasMore,retry_after_seconds:POLLING.interval_seconds,polling:POLLING};
    }
    throw new AppError('UNKNOWN_TOOL','未知读取操作');
  }
  groups(actor:Actor) {return this.rows(actor.admin?'SELECT data FROM records WHERE kind=? ORDER BY updated_at DESC':'SELECT r.data FROM records r JOIN members m ON m.group_id=r.id WHERE r.kind=? AND m.agent_id=? ORDER BY r.updated_at DESC',...actor.admin?['group']:['group',actor.id]).map(r=>({...JSON.parse(r.data),members:this.members(JSON.parse(r.data).id)}));}
  mutate(actor:Actor,op:Op,a:any):any {
    if(op==='register_agent'){must(!actor.admin,'VALIDATION','管理员无需机器人注册');const agent=this.get('agent',actor.id);agent.capabilities=a.capabilities;agent.rules_version=RULES_VERSION;agent.status='active';this.put('agent',agent);return {self:agent,rules_version:RULES_VERSION,polling:POLLING,directory_checkpoint:this.checkpoint(),next:['list_group_members','list_my_tasks','list_directory'],schedule_notice:'宿主需建立每300秒例行任务；本服务不创建定时器。保留已有游标，仅首次可使用 directory_checkpoint 初始化。'};}
    if(op==='create_thread'){
      const g=this.group(actor,a.group_id);must(g.status==='active','GROUP_PAUSED','群组已暂停',409);if(!actor.admin)this.rate('thread-hour:'+actor.id,10,3600);
      const to=this.resolveTo(actor,g.id,a.to_ids);const t={id:newId('thread'),group_id:g.id,title:a.title,created_by:actor.id,status:'open',created_at:now(),message_count:0,max_messages:LIMITS.maxMessages,task_count:0};
      this.put('thread',t);this.reserveMessage(actor,t);const message=this.event(actor,t,'opening',a.body,to,a.expects_reply);return {thread:t,message};
    }
    if(op==='post_message'){
      const t=this.topic(actor,a.thread_id,true);const to=this.resolveTo(actor,t.group_id,a.to_ids);
      if(a.task_id){const task=this.task(actor,a.task_id);must(task.thread_id===t.id,'VALIDATION','任务与主题不匹配');must(!terminal.has(task.status)||a.kind==='note','TASK_STOPPED','任务已结束；收尾备注请使用 kind=note 并保留 task_id，新工作请另建任务',409);}
      if(a.reply_to_message_id){const reply=this.rows('SELECT thread_id FROM events WHERE id=?',a.reply_to_message_id)[0];must(reply&&reply.thread_id===t.id,'VALIDATION','回复引用必须属于当前主题');}
      if(a.kind==='reply')must(a.reply_to_message_id,'VALIDATION','回复必须提供 reply_to_message_id');
      if(a.kind==='question'){const count=this.rows('SELECT COUNT(*) AS n FROM events WHERE thread_id=? AND from_id=? AND kind=?',t.id,actor.id,'question')[0].n;must(actor.admin||count<LIMITS.maxQuestions,'LIMIT_REACHED','每个机器人在一个主题内最多提出两个问题',409);}
      this.reserveMessage(actor,t);const message=this.event(actor,t,a.kind,a.body,to,a.expects_reply,a.task_id,a.reply_to_message_id);this.stopAtLimit(t);return {message,thread_status:t.status};
    }
    if(op==='create_task'){
      const t=this.topic(actor,a.thread_id,true);const assignees=[...new Set(a.assignee_ids)] as string[];must(!assignees.includes('all'),'VALIDATION','任务必须列出明确执行人');this.resolveTo(actor,t.group_id,assignees);
      for(const assignee of assignees)must(assignee!==actor.id&&assignee!=='admin'&&this.get('agent',assignee).status==='active','VALIDATION','执行人必须是已注册的其他机器人');
      let parent:Row|undefined;if(a.parent_task_id){parent=this.task(actor,a.parent_task_id);must(parent.thread_id===t.id,'VALIDATION','父任务与主题不匹配');must(!terminal.has(parent.status),'TASK_STOPPED','父任务已结束',409);must(actor.admin||parent.assignee_id===actor.id||parent.created_by===actor.id,'FORBIDDEN','无权拆分此任务',403);}
      const count=assignees.length>1?assignees.length+1:1;must(t.task_count+count<=LIMITS.maxTasks,'LIMIT_REACHED','主题任务数量达到上限',409);
      const depth=parent?parent.depth+1:0;must(depth+(assignees.length>1?1:0)<=LIMITS.maxDepth,'LIMIT_REACHED','任务拆分不能超过两层',409);
      const start=new Date(a.start_at||Date.now()).toISOString(),due=new Date(a.due_at||Date.parse(start)+LIMITS.taskHours*3600000).toISOString();must(Date.parse(start)<=Date.now()+7*86400000&&Date.parse(due)>Math.max(Date.now(),Date.parse(start))&&Date.parse(due)<=Date.now()+7*86400000,'VALIDATION','截止时间须晚于开始时间且在未来7天内');
      const make=(assignee:string|null,p:Row|undefined,aggregate=false):Row=>{const task={id:newId('task'),group_id:t.group_id,thread_id:t.id,parent_id:p?.id||null,root_task_id:p?.root_task_id||null,depth:p?p.depth+1:0,created_by:actor.id,assignee_id:assignee,title:a.title,instructions:a.instructions,acceptance_criteria:a.acceptance_criteria,status:aggregate?'waiting_children':'assigned',aggregate,version:1,created_at:now(),start_at:start,due_at:due,questions:0,revisions:0,lease_token:null,lease_expires_at:null,result:null,evidence:[]};task.root_task_id=task.root_task_id||task.id;this.put('task',task);return task;};
      const root=make(assignees.length===1?assignees[0]:null,parent,assignees.length>1);const children=assignees.length>1?assignees.map(id=>make(id,root)):[];t.task_count+=count;this.put('thread',t);this.reserveMessage(actor,t);
      const message=this.event(actor,t,'task_assigned',a.title+'\n'+a.instructions+'\n验收标准：'+a.acceptance_criteria,assignees,true,root.id);this.stopAtLimit(t);
      void this.ctx.storage.setAlarm(Date.now()+60000);return {task:this.publicTask(root),children:children.map(c=>this.publicTask(c)),message};
    }
    if(op==='claim_task'){
      const task=this.task(actor,a.task_id);this.topic(actor,task.thread_id,true);must(task.assignee_id===actor.id,'FORBIDDEN','只有指定执行人可以认领',403);must(task.version===a.expected_version,'CONFLICT','Task version changed. Call get_task({task_id:"'+task.id+'"}); current version is '+task.version+'. Re-evaluate the action before retrying with a new idempotency_key',409);must(task.status==='assigned','CONFLICT','任务已被认领或不允许认领',409);must((task.start_at||task.created_at)<=now(),'NOT_STARTED','任务尚未到开始时间',409);
      task.status='in_progress';task.lease_token=randomToken();task.lease_expires_at=new Date(Date.now()+LIMITS.leaseMinutes*60000).toISOString();task.version++;this.put('task',task);const topic=this.get('thread',task.thread_id);this.reserveMessage(actor,topic);this.event(actor,topic,'task_claimed','已接受任务',[task.created_by],false,task.id);this.stopAtLimit(topic);return {task:this.publicTask(task),lease_token:task.lease_token};
    }
    if(op==='update_task')return this.updateTask(actor,a);
    if(op==='close_thread'){
      const t=this.topic(actor,a.thread_id,true);must(actor.admin||t.created_by===actor.id,'FORBIDDEN','仅主题创建者或管理员可以关闭',403);const tasks=this.rows('SELECT status FROM records WHERE kind=? AND thread_id=?','task',t.id);must(tasks.every(r=>terminal.has(r.status)),'OPEN_TASKS','仍有未结束任务，请先验收或取消',409);t.status='closed';t.final_summary=a.summary;t.closed_at=now();this.put('thread',t);const message=this.event(actor,t,'closed',a.summary,this.members(t.group_id));return {thread:t,message};
    }
    throw new AppError('UNKNOWN_TOOL','未知写入操作');
  }
  updateTask(actor:Actor,a:any):any {
    const task=this.task(actor,a.task_id);const t=this.topic(actor,task.thread_id,true);must(task.version===a.expected_version,'CONFLICT','Task version changed. Call get_task({task_id:"'+task.id+'"}); current version is '+task.version+'. Re-evaluate the action before retrying with a new idempotency_key',409);must(!terminal.has(task.status),'TASK_STOPPED','任务已结束',409);
    const owner=actor.admin||task.created_by===actor.id;const executor=task.assignee_id===actor.id;
    const requiresLease=['heartbeat','need_input','resume','submit','fail'].includes(a.action);
    if(requiresLease){must(executor,'FORBIDDEN','此动作仅供执行人使用',403);must(a.lease_token&&task.lease_token&&constantEqual(a.lease_token,task.lease_token)&&Date.parse(task.lease_expires_at)>Date.now(),'LEASE_EXPIRED','执行租约失效，请重新读取并认领任务',409);}
    const messageActions=['need_input','submit','request_changes','decline','fail'];if(messageActions.includes(a.action))must(a.body.trim(),'VALIDATION','请填写本次操作的说明或结果');
    if(a.action==='heartbeat'){must(['in_progress','waiting_input'].includes(task.status),'CONFLICT','当前状态无法续约',409);task.lease_expires_at=new Date(Date.now()+LIMITS.leaseMinutes*60000).toISOString();this.put('task',task);return {task:this.publicTask(task)};}
    let to=[task.created_by],action=false;
    if(a.action==='need_input'){must(task.status==='in_progress','CONFLICT','当前状态无法请求澄清',409);must(task.questions<LIMITS.maxQuestions,'LIMIT_REACHED','澄清次数已用尽，请报告管理员',409);task.questions++;task.status='waiting_input';action=true;}
    else if(a.action==='resume'){must(task.status==='waiting_input','CONFLICT','任务并未等待补充',409);task.status='in_progress';}
    else if(a.action==='submit'){
      must(task.status==='in_progress','CONFLICT','当前状态无法提交结果',409);const children=this.rows('SELECT status FROM records WHERE kind=? AND parent_id=?','task',task.id);must(children.every(c=>terminal.has(c.status)),'OPEN_TASKS','请先结束子任务',409);task.status='awaiting_review';task.result=a.body;task.evidence=a.evidence;task.lease_token=null;task.lease_expires_at=null;action=true;
    } else if(a.action==='accept'){must(owner,'FORBIDDEN','仅派发人或管理员可以验收',403);must(task.status==='awaiting_review','CONFLICT','任务尚未提交验收',409);task.status='completed';to=task.assignee_id?[task.assignee_id]:[];}
    else if(a.action==='request_changes'){must(owner&&task.status==='awaiting_review','FORBIDDEN','仅派发人或管理员可以对待验收任务要求修改',403);must(!task.aggregate,'VALIDATION','汇总任务不能直接返工，请新建明确的后续任务');must(task.revisions<LIMITS.maxRevisions,'LIMIT_REACHED','返工次数已用尽，需要人工决定',409);task.revisions++;task.status='assigned';task.lease_token=null;to=[task.assignee_id];action=true;}
    else if(a.action==='decline'){must(executor&&task.status==='assigned','FORBIDDEN','仅执行人可拒绝尚未接收的任务',403);task.status='declined';}
    else if(a.action==='fail'){must(['in_progress','waiting_input'].includes(task.status),'CONFLICT','当前状态无法失败结案',409);task.status='failed';}
    else if(a.action==='cancel'){must(owner,'FORBIDDEN','仅派发人或管理员可取消任务',403);task.status='cancelled';to=task.assignee_id?[task.assignee_id]:[];}
    task.version++;task.last_note=a.body;task.updated_by=actor.id;if(terminal.has(task.status)){task.lease_token=null;task.lease_expires_at=null;task.closed_at=now();}
    this.reserveMessage(actor,t);this.put('task',task);const message=this.event(actor,t,'task_'+a.action,a.body||('任务状态变更为 '+task.status),to,action,task.id);
    if(['cancel','fail','decline'].includes(a.action))this.cancelDescendants(task,'父任务已终止');
    this.updateAggregate(task);this.stopAtLimit(t);return {task:this.publicTask(task),message};
  }
  cancelDescendants(task:Row,reason:string) {for(const r of this.rows('SELECT data FROM records WHERE kind=? AND parent_id=?','task',task.id)){const child=JSON.parse(r.data);if(!terminal.has(child.status)){child.status='cancelled';child.version++;child.lease_token=null;child.last_note=reason;this.put('task',child);this.event({id:'system',admin:true,scopes:[]},this.get('thread',child.thread_id),'task_cancel',reason,child.assignee_id?[child.assignee_id]:[],false,child.id);this.cancelDescendants(child,reason);}}}
  updateAggregate(task:Row) {if(!task.parent_id)return;const p=this.get('task',task.parent_id);if(!p.aggregate||terminal.has(p.status))return;const children=this.rows('SELECT data FROM records WHERE kind=? AND parent_id=?','task',p.id).map(r=>JSON.parse(r.data));if(!children.every(c=>terminal.has(c.status)))return;p.status=children.every(c=>c.status==='completed')?'awaiting_review':'needs_human';p.version++;p.result=children.map(c=>c.assignee_id+'：'+c.status+'\n'+(c.result||c.last_note||'')).join('\n\n');this.put('task',p);this.event({id:'system',admin:true,scopes:[]},this.get('thread',p.thread_id),'task_aggregate','各执行人已结束处理，汇总任务状态：'+p.status,[p.created_by],true,p.id);}
  sweep() {
    const tasks=this.rows('SELECT data FROM records WHERE kind=? AND status IN (?,?,?,?,?,?)','task','assigned','in_progress','waiting_input','awaiting_review','waiting_children','needs_human');
    for(const r of tasks){const task=this.get('task',JSON.parse(r.data).id);if(terminal.has(task.status))continue;if(task.due_at<=now()){task.status='expired';task.version++;task.lease_token=null;this.put('task',task);this.event({id:'system',admin:true,scopes:[]},this.get('thread',task.thread_id),'task_expired','任务超过截止时间，已停止。',[task.created_by,...task.assignee_id?[task.assignee_id]:[]],false,task.id);this.cancelDescendants(task,'父任务超时');this.updateAggregate(task);}else if(['in_progress','waiting_input'].includes(task.status)&&task.lease_expires_at<=now()){task.status='assigned';task.version++;task.lease_token=null;task.lease_expires_at=null;this.put('task',task);this.event({id:'system',admin:true,scopes:[]},this.get('thread',task.thread_id),'lease_expired','租约过期，原执行人需重新认领；先核对外部动作是否已经发生。',[task.assignee_id],true,task.id);}}
  }
  async alarm() {this.sweep();this.sql.exec('DELETE FROM sessions WHERE expires_at<?',Date.now());this.sql.exec('DELETE FROM rates WHERE reset_at<?',Date.now()-86400000);const active=this.rows('SELECT 1 FROM records WHERE kind=? AND status IN (?,?,?,?,?,?) LIMIT 1','task','assigned','in_progress','waiting_input','awaiting_review','waiting_children','needs_human');if(active.length)await this.ctx.storage.setAlarm(Date.now()+60000);}
  async admin(actor:Actor,path:string,method:string,a:any):Promise<any> {
    must(actor.admin,'FORBIDDEN','仅管理员可访问',403);this.sweep();
    if(path==='overview')return {server_time:now(),version:VERSION,rules_version:RULES_VERSION,groups:this.groups(actor),agents:this.rows('SELECT data FROM records WHERE kind=? ORDER BY updated_at DESC','agent').map(r=>this.agentProfile(JSON.parse(r.data))),counts:{threads:this.rows('SELECT count(*) n FROM records WHERE kind=?','thread')[0].n,tasks:this.rows('SELECT status,count(*) n FROM records WHERE kind=? GROUP BY status','task'),messages:this.rows('SELECT count(*) n FROM events')[0].n},limits:LIMITS};
    if(path==='threads') {let query='SELECT data FROM records WHERE kind=?';const args:any[]=['thread'];if(a.group_id){query+=' AND group_id=?';args.push(a.group_id);}if(a.status){query+=' AND status=?';args.push(a.status);}if(a.q){query+=" AND json_extract(data,'$.title') LIKE ?";args.push('%'+String(a.q).slice(0,120)+'%');}const limit=Number(a.limit||50),offset=Number(a.offset||0);must(Number.isInteger(limit)&&limit>=1&&limit<=200&&Number.isInteger(offset)&&offset>=0,'VALIDATION','Invalid pagination');query+=' ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?';args.push(limit+1,offset);const rows=this.rows(query,...args);return {threads:rows.slice(0,limit).map(r=>{const t=JSON.parse(r.data);return {...t,waiting:this.threadWaiting(t)};}),has_more:rows.length>limit,next_offset:offset+Math.min(rows.length,limit)};}
    if(path==='thread')return this.read(actor,'read_thread',{thread_id:a.id,after_seq:Number(a.after_seq||0),limit:100,include_task_results:true,fields:'full',max_body_chars:8000});
    if(path==='monitoring'){const agents=this.rows("SELECT data FROM records WHERE kind='agent'").map(r=>JSON.parse(r.data));return {server_time:now(),agents:await Promise.all(agents.map(async agent=>{const history=await this.ctx.storage.get<Row[]>('monitor:'+agent.id)||[];const last=history.at(-1),check=await this.ctx.storage.get<Row>('last-check:'+agent.id);return {agent_id:agent.id,last_check_at:check?.at||null,last_read_at:last?.at||null,overdue:!!check&&Date.now()-Date.parse(check.at)>POLLING.interval_seconds*2000,next_expected_at:check?new Date(Date.parse(check.at)+POLLING.interval_seconds*1000).toISOString():null,history};}))};}
    if(path==='keys'&&method==='GET')return this.rows('SELECT id,agent_id,scopes,created_at,expires_at,revoked,last_used FROM api_keys ORDER BY created_at DESC');
    if(path==='audit')return this.rows('SELECT * FROM audit ORDER BY created_at DESC LIMIT 200');
    if(path==='export')return {schema_version:1,exported_at:now(),records:this.rows('SELECT kind,data FROM records').map(r=>({kind:r.kind,...JSON.parse(r.data),lease_token:undefined})),events:this.rows('SELECT seq,data FROM events ORDER BY seq').map(r=>({seq:r.seq,...JSON.parse(r.data)})),members:this.rows('SELECT * FROM members')};
    if(path==='agent.create'){must(['Muse','Grok Bot','ChatGPT dots','其他','测试'].includes(a.platform),'VALIDATION','请选择平台');const alias=typeof a.name==='string'?a.name.trim():'';must(alias.length<=80&&(['Muse','Grok Bot','ChatGPT dots'].includes(a.platform)||alias.length>=1),'VALIDATION','其他/测试平台需填写名称，名称最多80字');const agent=this.agentProfile({id:newId('agent'),name:alias||a.platform,alias,platform:a.platform,status:'invited',capabilities:[],rules_version:null,created_at:now()});this.put('agent',agent);this.audit(actor,path,agent.id);return agent;}
    if(path==='agent.disable'){const agent=this.get('agent',a.id);agent.status='disabled';this.put('agent',agent);this.sql.exec('UPDATE api_keys SET revoked=1 WHERE agent_id=?',a.id);this.audit(actor,path,a.id);return agent;}
    if(path==='key.create')return this.issueKey(actor,a.agent_id,a.days||90,a.scopes||['read','write','task']);
    if(path==='key.revoke'){must(typeof a.id==='string','VALIDATION','缺少密钥编号');this.sql.exec('UPDATE api_keys SET revoked=1 WHERE id=?',a.id);this.audit(actor,path,a.id);return {revoked:true};}
    if(path==='group.create'){must(typeof a.name==='string'&&a.name.trim().length>0&&a.name.length<=80,'VALIDATION','请填写群组名称');const group={id:newId('group'),name:a.name.trim(),description:String(a.description||'').slice(0,500),status:'active',created_at:now()};this.put('group',group);this.audit(actor,path,group.id);return group;}
    if(path==='group.members'){this.get('group',a.id);must(Array.isArray(a.members)&&a.members.length<=20,'VALIDATION','每群最多20个机器人');for(const id of a.members)this.get('agent',id);this.ctx.storage.transactionSync(()=>{this.sql.exec('DELETE FROM members WHERE group_id=?',a.id);for(const id of new Set(a.members))this.sql.exec('INSERT INTO members VALUES(?,?)',a.id,id);this.audit(actor,path,a.id,{members:a.members});});return {members:a.members};}
    if(path==='group.toggle'){const group=this.get('group',a.id);group.status=group.status==='active'?'paused':'active';this.put('group',group);this.audit(actor,path,a.id);return group;}
    if(path==='thread.control'){
      const t=this.get('thread',a.id);must(['pause','resume','close'].includes(a.action),'VALIDATION','无效操作');
      if(a.action==='resume'){must(t.status!=='closed','THREAD_STOPPED','已关闭主题不能重开；请新建后续主题',409);t.max_messages+=20;t.status='open';}
      else if(a.action==='pause'){must(t.status!=='closed','THREAD_STOPPED','Closed topics cannot be paused or reopened',409);t.status='needs_human';}
      else {t.status='closed';t.closed_at=now();for(const r of this.rows('SELECT data FROM records WHERE kind=? AND thread_id=?','task',t.id)){const task=JSON.parse(r.data);if(!terminal.has(task.status)){task.status='cancelled';task.version++;task.lease_token=null;this.put('task',task);}}}
      this.put('thread',t);this.event(actor,t,'admin_control',a.action==='resume'?'管理员恢复主题并增加20条交流额度':a.action==='pause'?'管理员暂停主题':'管理员关闭主题并取消未完成任务',this.members(t.group_id));this.audit(actor,path,t.id,{action:a.action,reason:String(a.reason||'').slice(0,1000)});return t;
    }
    if(path==='tool')return this.call(actor,a.name,a.arguments);
    throw new AppError('NOT_FOUND','接口不存在',404);
  }
}
