// Pi/OpenAI: native Pi runtime against a further copy of an already-copied JSONL.
// Network, credentials and execution tools are disabled. No original session is opened.
import {copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {Type} from 'typebox';
import prototype from '../src/prototype.ts';
const [snapshot, leaf, sdkRoot, compactionCopy] = process.argv.slice(2);
if (!snapshot || !leaf || !sdkRoot || !compactionCopy) throw new Error('Supply copied JSONL, branch leaf, installed SDK root, copied compaction package');
if (!/copy/i.test(snapshot)) throw new Error('Supply the named copy, never a live session path');
const hash = () => createHash('sha256').update(readFileSync(snapshot)).digest('hex');
const beforeHash = hash();
const cwd = mkdtempSync(join(tmpdir(),'goals-prototype-replay-'));
const file = join(cwd,'session-copy.jsonl'); copyFileSync(snapshot,file);
const sdk = await import(pathToFileURL(join(sdkRoot,'dist/index.js')).href);
const {rewriteResponsesPayloadWithNativeReplay} = await import(pathToFileURL(resolve(compactionCopy,'src/payload-rewrite.ts')).href);
const {serializeMessagesToResponsesInput} = await import(pathToFileURL(resolve(compactionCopy,'src/serializer.ts')).href);
const sm = sdk.SessionManager.open(file); sm.branch(leaf);
const plan = join(cwd,'plan.md'); writeFileSync(plan,'# Copy-only plan\n- [ ] goal: inspect copied history only\n\n## Log\n');
sm.appendCustomEntry('pi-goals-main-supervisor-v1',{mode:'planning',plan,signoffs:{}});
let context; const commands = new Map(); const compactHooks=[]; let contextHooks=0; let requests=0; let network=0;
const realFetch=globalThis.fetch;globalThis.fetch=async()=>{network++;throw new Error('Network forbidden');};
let session;
try {
 sdk.initTheme('dark',false);
 const settings=sdk.SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
 const agentDir=join(cwd,'agent');mkdirSync(agentDir);
 const runtime=await sdk.ModelRuntime.create({authPath:join(agentDir,'no-auth.json'),modelsPath:join(agentDir,'no-models.json'),modelsStorePath:join(agentDir,'no-store.json'),allowModelNetwork:false});
 await runtime.setRuntimeApiKey('github-copilot','synthetic-no-network');
 const model={provider:'github-copilot',api:'openai-responses',id:'gpt-6-astra',baseUrl:'https://api.enterprise.githubcopilot.com',reasoning:true,input:['text','image'],contextWindow:400000,maxTokens:32768,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
 const loader=new sdk.DefaultResourceLoader({cwd,agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,agentsFilesOverride:()=>({agentsFiles:[]}),extensionFactories:[(pi)=>{
  const wrapped=new Proxy(pi,{get(target,key){
   if(key==='registerCommand')return (name,definition)=>{commands.set(name,definition);return target.registerCommand(name,definition);};
   if(key==='on')return (event,handler)=>{if(event==='context')contextHooks++;if(event==='session_compact')compactHooks.push(handler);return target.on(event,handler);};
   return Reflect.get(target,key);
  }});
  prototype(wrapped);
  // Schema-only edxeth stand-ins: launching any child is forbidden in the replay check.
  for(const [name,parameters] of [['subagent',Type.Object({agent:Type.String(),title:Type.String()})],['subagent_resume',Type.Object({sessionFile:Type.String()})],['subagent_kill',Type.Object({id:Type.String()})]]) pi.registerTool({name,label:name,description:'Do not execute',parameters,execute:async()=>{throw new Error('Delegation forbidden in replay check');}});
  pi.on('session_start',(_e,ctx)=>{context=ctx;});
 }]});
 await loader.reload();assert.equal(loader.getExtensions().errors.length,0);
 ({session}=await sdk.createAgentSession({cwd,agentDir,sessionManager:sm,settingsManager:settings,resourceLoader:loader,modelRuntime:runtime,model,noTools:true}));
 await session.bindExtensions({onError:e=>{throw new Error(JSON.stringify(e));}});
 assert.equal(context.cwd,cwd);assert.equal(contextHooks,0);
 session.agent.streamFunction=async(_model,ctx)=>{
  requests++;
  assert.ok(ctx.systemPrompt.includes(requests===1?'Plan only.':'You are the goal supervisor in the main chat.'));
  if(requests>1)assert.ok(!ctx.systemPrompt.includes('Plan only.'));
  const input=serializeMessagesToResponsesInput(model,ctx.messages);
  const checkpoint=sm.getBranch().findLast(e=>e.type==='compaction');
  const replay=rewriteResponsesPayloadWithNativeReplay({model,payload:{model:model.id,instructions:ctx.systemPrompt,input},branchEntries:sm.getBranch(),compactionEntry:checkpoint});
  assert.equal(replay.ok,true,`Copied replay rejected: ${replay.reason}`);
  const m={role:'assistant',content:[{type:'text',text:'COPY_ONLY_OK'}],provider:model.provider,model:model.id,api:model.api,stopReason:'stop',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  return {async *[Symbol.asyncIterator](){yield {type:'done',reason:'stop',message:m};},result:async()=>m};
 };
 await session.prompt('Copy-only planning check. No work; reply COPY_ONLY_OK.');
 const settled=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Ready did not settle')),10000);const unsub=session.subscribe(e=>{if(e.type==='agent_settled'){clearTimeout(timeout);unsub();resolve();}});});
 await commands.get('goals').handler('ready',context);
 await settled;
 // A notification does not compact, rewrite history or start another request.
 for(const hook of compactHooks)await hook({},context);
 await session.prompt('Copy-only post-compaction-notice check. No work; reply COPY_ONLY_OK.');
 assert.equal(requests,3);assert.equal(network,0);assert.equal(hash(),beforeHash);
 console.log(JSON.stringify({passed:true,requests,network,contextHooks,readyRole:'supervising',snapshotUnchanged:true,scope:'Actual Pi SDK + copied native checkpoint, deterministic model; compaction notification simulated'}));
} finally {session?.dispose();globalThis.fetch=realFetch;rmSync(cwd,{recursive:true,force:true});}
