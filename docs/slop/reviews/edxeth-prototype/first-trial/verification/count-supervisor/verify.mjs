import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,chmodSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const dir=mkdtempSync('evidence/count-supervisor/run-');
const save=(name,data)=>writeFileSync(`${dir}/${name}`,data);
const run=(name,cmd,args)=>{
 save(`${name}.command.json`,JSON.stringify({cmd,args}));
 const r=spawnSync(cmd,args);
 save(`${name}.stdout`,r.stdout??Buffer.alloc(0));
 save(`${name}.stderr`,r.stderr??Buffer.alloc(0));
 save(`${name}.status.json`,JSON.stringify({status:r.status,signal:r.signal,error:r.error?.message}));
 assert.ifError(r.error); assert.equal(r.signal,null); assert.equal(typeof r.status,'number'); return r;
};
assert.notEqual(process.getuid(),0);
save('identity.json',JSON.stringify({uid:process.getuid(),gid:process.getgid()}));
writeFileSync(`${dir}/empty`,Buffer.alloc(0));
writeFileSync(`${dir}/unicode`,'é🙂\n');
writeFileSync(`${dir}/binary`,Buffer.from([0,255,128,10,13,0]));
writeFileSync(`${dir}/denied`,'private'); chmodSync(`${dir}/denied`,0);
let deniedCode; try {readFileSync(`${dir}/denied`);}catch(e){deniedCode=e.code;}
save('direct-denial.json',JSON.stringify({code:deniedCode})); assert.equal(deniedCode,'EACCES');
const cases=[['greeting',['greeting.txt'],13],['empty',[`${dir}/empty`],0],['unicode',[`${dir}/unicode`],7],['binary',[`${dir}/binary`],6],['missing',[]],['extra',['greeting.txt',`${dir}/empty`]],['nonexistent',[`${dir}/nonexistent`]],['denied',[`${dir}/denied`]]];
for(const [name,args,n] of cases){
 const r=run(name,process.execPath,['count.mjs',...args]);
 if(n!==undefined){assert.equal(r.status,0); assert.deepEqual(r.stdout,Buffer.from(`${n}\n`)); assert.equal(r.stderr.length,0);}
 else {assert.notEqual(r.status,0); assert.equal(r.stdout.length,0); assert.ok(r.stderr.length>0);}
 if(name==='denied') assert.match(r.stderr.toString(),/EACCES/);
 console.log(`PASS ${name}`);
}
const ignored=run('ignored','git',['check-ignore','evidence/count-worker/verify.mjs','evidence/count-supervisor/verify.mjs',dir]);
assert.equal(ignored.status,0); assert.equal(ignored.stdout.toString().trim().split('\n').length,3);
const tracked=run('tracked','git',['ls-files','--','evidence/']); assert.equal(tracked.status,0); assert.equal(tracked.stdout.length,0);
save('summary.json',JSON.stringify({passed:true,cases:8,uid:process.getuid(),ignored:true,tracked:false},null,2));
console.log(`PASS all checks; evidence: ${dir}`);
