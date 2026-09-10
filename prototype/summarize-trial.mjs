// Sanitized, task-local evidence. Never copy auth, provider response IDs, or raw private sessions.
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync,copyFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
const [root,output]=process.argv.slice(2);if(!root||!output)throw new Error('trial root and evidence directory required');
const sessionsRoot=join(root,'agent/sessions');
const summaries=[];
for(const name of readdirSync(sessionsRoot,{recursive:true}).filter(p=>p.endsWith('.jsonl'))){
 const file=join(sessionsRoot,name);const entries=readFileSync(file,'utf8').split('\n').filter(Boolean).map(JSON.parse);
 const state=entries.findLast(e=>e.type==='custom'&&e.customType==='pi-goals-main-supervisor-v1')?.data;
 const launch=entries.find(e=>e.type==='custom'&&e.customType==='pi-subagents_launch_metadata')?.data;
 const results=entries.filter(e=>e.type==='message'&&e.message.role==='toolResult').map(e=>({tool:e.message.toolName,isError:!!e.message.isError,...(['subagent','subagent_resume'].includes(e.message.toolName)?{id:e.message.details?.id,status:e.message.details?.status,mode:e.message.details?.mode,sessionFile:e.message.details?.sessionFile}:{}),...(['CompleteGoal','subagent','subagent_resume'].includes(e.message.toolName)?{text:e.message.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')}: {})}));
 const writes=entries.filter(e=>e.type==='message'&&e.message.role==='assistant').flatMap(e=>(e.message.content??[]).filter(b=>b.type==='toolCall'&&['write','edit'].includes(b.name)).map(b=>({tool:b.name,path:b.arguments.path??b.arguments.file_path})));
 const final=entries.filter(e=>e.type==='message'&&e.message.role==='assistant').at(-1)?.message.content.filter(b=>b.type==='text').map(b=>b.text).join('\n');
 summaries.push({file,sessionId:entries.find(e=>e.type==='session')?.id,state,launch:launch?{mode:launch.mode,sessionMode:launch.sessionMode,parentClosePolicy:launch.parentClosePolicy,model:launch.model,extensions:launch.extensions,tools:launch.tools,skills:launch.skills}:undefined,results,writes,final});
}
mkdirSync(output,{recursive:true});writeFileSync(join(output,'sessions-summary.json'),JSON.stringify(summaries,null,2));
const project=join(root,'project');
for(const file of ['greeting.txt','count.mjs','.gitignore'])if(existsSync(join(project,file)))copyFileSync(join(project,file),join(output,file));
const evidence=join(project,'evidence');
if(existsSync(evidence))for(const name of readdirSync(evidence,{recursive:true})){
 if(name.split('/').includes('fixtures')||! /\.(txt|json|mjs|log|stdout|stderr|exit)$/.test(name))continue;
 const src=join(evidence,name);const out=join(output,'verification',name);mkdirSync(dirname(out),{recursive:true});copyFileSync(src,out);
}
for(const item of summaries.filter(s=>s.state?.plan&&!s.state.child))if(existsSync(item.state.plan))copyFileSync(item.state.plan,join(output,'plan.md'));
console.log(JSON.stringify({sessions:summaries.length,parentSignedOff:summaries.filter(s=>!s.state?.child).map(s=>Object.keys(s.state?.signoffs??{}).length),output}));
