/** Config coverage check: every taxonomy cause must have a reachable playbook. */
import { loadConfig } from "@rra/core";

const c = loadConfig();
const causes = [...new Set(c.taxonomy.entries().map((e) => e.cause))].sort();
const missing = causes.filter((cause) => !c.playbooks.has("payment_failure", cause));
console.log(`taxonomy causes: ${causes.length}`);
console.log(`playbooks: ${c.playbooks.all().length}`);
console.log(missing.length ? `NO PLAYBOOK: ${missing.join(", ")}` : "every cause has a playbook");
if (missing.length) process.exit(1);
