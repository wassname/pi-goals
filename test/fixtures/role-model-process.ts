import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ModelRole, RoleModels } from "../../src/role-models.js";

const [directory, role, provider, id] = process.argv.slice(2);
let selected: (event: any, ctx: any) => void;
const pi = { on(_name: string, handler: any) { selected = handler; }, setModel: async () => true };
const ctx = { model: { provider, id }, modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) }, ui: { notify(message: string) { throw new Error(message); } } };
const models = new RoleModels(pi as unknown as ExtensionAPI, directory);
await models.enter(role as ModelRole, ctx as unknown as ExtensionContext);
selected!({ source: "cycle", model: { provider, id } }, ctx);
