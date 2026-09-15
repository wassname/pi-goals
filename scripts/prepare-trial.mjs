// Pi/OpenAI. Prepare an isolated trial; never launches/reloads an existing session.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [sdkRoot, option, modelUrl, ...extra] = process.argv.slice(2);
if (!sdkRoot || extra.length || (option !== undefined && option !== '--offline') || (option === '--offline' && !modelUrl)) throw new Error('Usage: node scripts/prepare-trial.mjs INSTALLED_PI_ROOT [--offline LOOPBACK_MODEL_URL]');
const offline = option === '--offline';
if (offline) {
	const url = new URL(modelUrl);
	if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Offline fixtures require an HTTP loopback model URL without credentials.');
}
const revision = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
const root = mkdtempSync(join(tmpdir(), 'goals-nico-trial-'));
const cwd = join(root, 'project'); const agentDir = join(root, 'agent');
mkdirSync(cwd); mkdirSync(agentDir, {mode:0o700});
let sourceSettings = {}, packages = [], retained = [];
if (offline) {
	// Allow only the candidate's required resources and the existing deterministic model fixture.
	// Do not read the real profile, discover its packages, or copy its credentials.
	sourceSettings = { extensions:[join(repo,'test/fixtures/offline-model.ts')], defaultProvider:'offline', defaultModel:'test', enabledModels:['offline/test'], compaction:{enabled:false} };
	writeFileSync(join(agentDir,'auth.json'), '{}\n');
	writeFileSync(join(agentDir,'models.json'), '{"providers":{}}\n');
} else {
	const sourceAgent = process.env.PI_CODING_AGENT_DIR || join(homedir(),'.pi','agent');
	sourceSettings = JSON.parse(readFileSync(join(sourceAgent,'settings.json'),'utf8'));
	const sdk = await import(pathToFileURL(join(sdkRoot,'dist/index.js')).href);
	const settings = sdk.SettingsManager.create(repo, sourceAgent, { projectTrusted:false });
	const manager = new sdk.DefaultPackageManager({cwd:repo, agentDir:sourceAgent, settingsManager:settings});
	packages = manager.listConfiguredPackages().filter((p) => p.scope !== 'project' && !/^\/\//.test(p.source));
	retained = packages.filter((p) => !/pi-subagents|pi-goals|pi-intercom|pi-schedule-prompt|@jl1990\/pi-scheduler/.test(p.source));
	for (const p of retained) if (!p.installedPath) throw new Error(`Missing installed package: ${p.source}`);
	// Private copies, not symlinks: a trial OAuth refresh must not write the active auth file.
	for (const file of ['auth.json','models.json']) if (existsSync(join(sourceAgent,file))) copyFileSync(join(sourceAgent,file),join(agentDir,file));
}
writeFileSync(join(agentDir,'settings.json'), JSON.stringify({...sourceSettings, packages:[...retained.map((p)=>p.installedPath), repo]},null,2));
execFileSync('git',['init','--quiet',cwd]);
writeFileSync(join(cwd,'AGENTS.md'), 'Isolated functional trial. Work only in this project. Do not operate other Herdr panes, use live research sessions, or change global settings. Preserve evidence. The main chat supervises; the goals-worker implements.\n');
writeFileSync(join(cwd,'.gitignore'), 'evidence/\n');
const stateFile = join(root,'scheduler/tasks.json');
const manifest={root,cwd,agentDir,repo,revision,profile:offline?'offline':'inherited',stateFile,retainedPackages:retained.map((p)=>p.source),replacedPackages:packages.filter((p)=>!retained.includes(p)).map((p)=>p.source)};
writeFileSync(join(root,'manifest.json'),JSON.stringify(manifest,null,2));
const quote=(s)=>`'${s.replaceAll("'", "'\\''")}'`;
writeFileSync(join(root,'start.zsh'), `#!/usr/bin/env zsh\nset -e\ncd ${quote(cwd)}\nexport PI_CODING_AGENT_DIR=${quote(agentDir)}\nexport PI_SCHEDULER_STATE_FILE=${quote(stateFile)}\n${offline ? `export PI_OFFLINE=1\nexport PI_GOALS_OFFLINE_MODEL_URL=${quote(modelUrl)}\nexec pi --model offline/test` : 'exec pi'}\n`,{mode:0o700});
console.log(JSON.stringify({root,cwd,agentDir,start:join(root,'start.zsh'),manifest:join(root,'manifest.json')},null,2));
