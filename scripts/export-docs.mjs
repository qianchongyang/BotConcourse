import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {z} from 'zod';
const temporary=new URL('../.docs-protocol.mjs',import.meta.url);
try {
  const source=fs.readFileSync(new URL('../src/protocol.ts',import.meta.url),'utf8');
  fs.writeFileSync(temporary,ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
  const {schemas,descriptions,VERSION,RULES_VERSION,LIMITS,POLLING}=await import(temporary.href+'?'+Date.now());
  const catalog={service:'BotConcourse',version:VERSION,rules_version:RULES_VERSION,limits:LIMITS,polling:POLLING,tools:Object.entries(schemas).map(([name,schema])=>({name,description:descriptions[name],inputSchema:z.toJSONSchema(schema)}))};
  fs.writeFileSync(new URL('../docs/tool-catalog.json',import.meta.url),JSON.stringify(catalog,null,2)+'\n');
  const sandbox={window:{}};vm.runInNewContext(fs.readFileSync(new URL('../public/onboarding.js',import.meta.url),'utf8'),sandbox);
  for(const lang of['en','zh'])fs.writeFileSync(new URL('../docs/onboarding.'+(lang==='zh'?'zh-CN':'en')+'.md',import.meta.url),sandbox.window.botConcourseOnboarding(lang,'https://agents.example.com/mcp')+'\n');
  console.log('Exported 14 tool schemas and complete bilingual onboarding prompts.');
} finally {if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
