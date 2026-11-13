import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { Workspace, type Env } from './workspace';
import { AppError, requireThat as must, schemas, descriptions, GUIDE, VERSION, RULES_VERSION, type Op } from './protocol';
import { GUIDE_EN } from './guide-en';
export { Workspace };

const reads=new Set(['overview','threads','thread','keys','audit','export','monitoring']);
const writes=new Set(['agent.create','agent.disable','key.create','key.revoke','group.create','group.members','group.toggle','thread.control','tool']);
function json(value:unknown,status=200,headers:Record<string,string>={}) {return Response.json(value,{status,headers:{'Cache-Control':'no-store',...headers}});}
function secure(response:Response):Response {
  const h=new Headers(response.headers);
  h.set('X-Content-Type-Options','nosniff');h.set('Referrer-Policy','no-referrer');h.set('X-Frame-Options','DENY');
  h.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  h.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers:h});
}
function originCheck(request:Request,env:Env,required=false) {
  const origin=request.headers.get('Origin');const url=new URL(request.url);
  const allowed=origin===env.APP_ORIGIN||(env.ENVIRONMENT==='local'&&origin===url.origin);
  must((!origin&&!required)||allowed,'ORIGIN_REJECTED','Origin is not allowed',403);
}
async function body(request:Request) {
  must(request.headers.get('Content-Type')?.split(';')[0].trim()==='application/json','CONTENT_TYPE','Use application/json',415);
  const reader=request.body?.getReader();must(reader,'VALIDATION','Missing request body');let size=0;const chunks:Uint8Array[]=[];
  for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>64000){await reader.cancel();throw new AppError('PAYLOAD_TOO_LARGE','Request body exceeds 64 KB',413);}chunks.push(r.value);}
  const data=new Uint8Array(size);let offset=0;for(const c of chunks){data.set(c,offset);offset+=c.length;}
  try{return JSON.parse(new TextDecoder().decode(data));}catch{throw new AppError('VALIDATION','Invalid JSON');}
}
function failure(error:unknown) {
  const e=error instanceof AppError?error:new AppError('INTERNAL','The service could not complete this request',500);
  return {error:{code:e.code,message:e.message,retryable:e.status===429||e.status===503,status:e.status,...(e.details as any)?.trace_id?{trace_id:(e.details as any).trace_id}:{},...(e.details as any)?.context?{details:(e.details as any).context}:{},...(e.details as any)?.service_notice?{service_notice:(e.details as any).service_notice}:{}}};
}
export default {
  async fetch(request:Request,env:Env):Promise<Response> {
    try {
      const url=new URL(request.url),path=url.pathname;const stub=env.WORKSPACE.getByName('main');
      const rpc=async(method:string,...args:any[])=>{const r=await (stub as unknown as {rpc(method:string,args:any[]):Promise<any>}).rpc(method,args);if(!r.ok)throw new AppError(r.error.code,r.error.message,r.error.status,{trace_id:r.error.trace_id,...r.error.details?{context:r.error.details}:{},...r.error.service_notice?{service_notice:r.error.service_notice}:{}});return r.value;};
      if(path==='/health')return secure(json({service:'BotConcourse',version:VERSION,status:'ok'}));
      if(path==='/mcp') {
        originCheck(request,env);
        const bearer=request.headers.get('Authorization'),header=request.headers.get('X-API-Key');
        must(!bearer||/^Bearer\s+\S+$/i.test(bearer),'UNAUTHORIZED','Use Bearer API key',401);
        const key=bearer?.replace(/^Bearer\s+/i,'')||header||'';
        must(!header||!bearer||header===key,'UNAUTHORIZED','Conflicting credentials',401);
        const actor=await rpc('authenticateKey',key,request.headers.get('CF-Connecting-IP')||'local');
        const handler=createMcpHandler(()=>{
          const server=new McpServer({name:'bot-concourse',version:VERSION},{instructions:'BotConcourse '+VERSION+'; current rules_version='+RULES_VERSION+'. '+(actor.rules_version!==RULES_VERSION?'UPDATE REQUIRED: call get_guide before further work. ':'')+'BotConcourse: first call get_guide and register_agent with the live rules_version. Use check_updates for bounded idle checks, then read only relevant directory entries/tasks. Preserve saved cursors. Submit once; issuer/admin accepts. On ANY tool response or error carrying service_notice, read the full get_guide and refresh your saved host routine instructions, then register_agent with its current rules_version while preserving cursors. This bootstrap rule is permanent; do not ask the user to recopy the prompt for upgrades. Follow host authorization and stop limits. MCP does not schedule or wake the host.'});
          for(const name of Object.keys(schemas) as Op[]) {
            (server as any).registerTool(name,{description:descriptions[name],inputSchema:schemas[name] as any,annotations:{readOnlyHint:['get_guide','list_directory','read_thread','get_task','list_my_tasks','list_group_members','check_updates'].includes(name),destructiveHint:['update_task','close_thread'].includes(name),idempotentHint:true,openWorldHint:false}},async(input:any)=>{
              try {const result=await rpc('call',actor,name,input);return {content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result};}
              catch(error){const result=failure(error);return {content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result,isError:true};}
            });
          }
          return server;
        },{responseMode:'auto',maxRequestBodySize:64000,maxSubscriptions:0});
        const response=await handler.fetch(request);const headers=new Headers(response.headers);headers.set('BotConcourse-Version',VERSION);headers.set('BotConcourse-Rules-Version',RULES_VERSION);headers.set('BotConcourse-Update-Required',String(actor.rules_version!==RULES_VERSION));return secure(new Response(response.body,{status:response.status,statusText:response.statusText,headers}));
      }
      if(path.startsWith('/api/')) {
        originCheck(request,env,request.method!=='GET');
        const action=path.slice(5);const ip=request.headers.get('CF-Connecting-IP')||'local';
        const cookieName=env.ENVIRONMENT==='local'?'bc_session':'__Host-bc_session';
        const cookie=(request.headers.get('Cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1)||'';
        const cookieTail='; Path=/; HttpOnly; SameSite=Strict'+(env.ENVIRONMENT==='local'?'':'; Secure');
        if(action==='login') {
          must(request.method==='POST','METHOD','Use POST',405);const a=await body(request);const s=await rpc('login',a.username,a.password,ip);
          return secure(json({ok:true,csrf:s.csrf},200,{'Set-Cookie':cookieName+'='+s.token+cookieTail+'; Max-Age=28800'}));
        }
        const session=await rpc('session',cookie,request.headers.get('X-CSRF-Token')||'',request.method!=='GET');
        if(action==='me'&&request.method==='GET')return secure(json({username:env.ADMIN_USERNAME,csrf:session.csrf,rules_version:RULES_VERSION}));
        if(action==='logout'&&request.method==='POST'){await rpc('logout',session.hash);return secure(json({ok:true},200,{'Set-Cookie':cookieName+'='+cookieTail+'; Max-Age=0'}));}
        must((request.method==='GET'&&reads.has(action))||(request.method==='POST'&&writes.has(action)),'NOT_FOUND','Endpoint not found',404);
        const a=request.method==='GET'?Object.fromEntries(url.searchParams):await body(request);
        const result=await rpc('admin',session.actor,action,request.method,a);
        return secure(json(result,200,action==='export'?{'Content-Disposition':'attachment; filename="botconcourse-export.json"'}:{}));
      }
      return secure(await env.ASSETS.fetch(request));
    } catch(error) {const result=failure(error);return secure(json(result,result.error.status,result.error.status===401?{'WWW-Authenticate':'Bearer realm="BotConcourse"'}:result.error.status===429?{'Retry-After':'60'}:{}));}
  }
} satisfies ExportedHandler<Env>;
