import { closePool } from "@rra/db";
import { renderReplay, verifyReplay } from "@rra/sim";

const report = await verifyReplay();
console.log(renderReplay(report));
await closePool();
if (!report.ok) process.exit(1);
