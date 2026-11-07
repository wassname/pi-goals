import { readFileSync, writeFileSync } from "node:fs";
const [repo, goalsFile, mode] = process.argv.slice(2);
const g = await import(`${repo}/src/goals.ts`);
const p = await import(`${repo}/src/prompts.ts`);
const t = readFileSync(goalsFile, "utf8");
const st = g.section(t, "Loop statement");
const out = mode === "old" ? p.loopPrompt(st, g.loopFocus(t), goalsFile)
  : p.loopPrompt(st, g.loopFocus(t), g.ageTasks(t, {}, Date.now()).lines, goalsFile, { id: "task_example", schedule: "1h" });
process.stdout.write(out);
