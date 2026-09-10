// Event-driven trial observer. Reads only child panes named by this trial's launch trace.
import {existsSync,readFileSync,writeFileSync,watch} from 'node:fs';
import {execFile} from 'node:child_process';
import {join} from 'node:path';
const root=process.argv[2];if(!root)throw new Error('trial root required');
const trace=join(root,'launch.jsonl');if(!existsSync(trace))writeFileSync(trace,'');
const seen=new Set();const watchers=[];let count=0;
const shutdown=()=>{for(const w of watchers)w.close();process.exit(count?0:1);};
const deadline=setTimeout(shutdown,600000);
function observe(){
 for(const line of readFileSync(trace,'utf8').trim().split('\n')){
  let row;try{row=JSON.parse(line);}catch{continue;}
  if(!['interactive.send','interactive.watch.start'].includes(row.event)||!row.sessionFile?.startsWith(root+'/agent/sessions/')||!row.surface)continue;
  const pane=row.surface.replace(/^herdr:/,'');
  if(seen.has(pane))continue;
  seen.add(pane);
  // Herdr IDs are opaque (p1A is valid); use the trace value, not a numeric-ID assumption.
  row.id = row.id ?? pane.replaceAll(':','-');
  // Capture once Pi renders its model/footer, without sending input or taking focus.
  execFile('herdr',['pane','wait-output',pane,'--regex','gpt-|Claude|Gemini','--timeout','45000','--lines','120'],{maxBuffer:1024*1024},(error,stdout,stderr)=>{
   writeFileSync(join(root,`worker-${row.id}-pane.txt`),stdout+stderr);
   console.log(JSON.stringify({event:'worker-pane-captured',id:row.id,pane,ok:!error,path:join(root,`worker-${row.id}-pane.txt`)}));
   count++;
   if(count>=2){clearTimeout(deadline);shutdown();}
  });
 }
}
watchers.push(watch(trace,observe));observe();
