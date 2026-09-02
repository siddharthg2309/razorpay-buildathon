import { createServer } from "node:http";
import { closePool } from "@rra/db";
import { batchScreen } from "./screens/batch.js";
import { caseScreen, casesScreen } from "./screens/cases.js";
import { incidentsScreen } from "./screens/incidents.js";
import { policyScreen } from "./screens/policy.js";
import { attributionScreen } from "./screens/attribution.js";
import { streamScreen } from "./screens/stream.js";
import { sse } from "./stream.js";
import { page, panel } from "./render.js";

const PORT = Number(process.env["PORT"] ?? 4000);

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    try {
      if (path === "/events") {
        const close = sse(res, Number(url.searchParams.get("after") ?? 0));
        req.on("close", close);
        return;
      }

      let html: string;
      if (path === "/") html = await batchScreen();
      else if (path === "/cases") html = await casesScreen(url.searchParams.get("state") ?? undefined);
      else if (path.startsWith("/case/")) html = await caseScreen(decodeURIComponent(path.slice(6)));
      else if (path === "/incidents") html = await incidentsScreen();
      else if (path === "/policy") html = await policyScreen();
      else if (path === "/attribution") html = await attributionScreen();
      else if (path === "/stream") html = streamScreen();
      else {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page("not found", "", panel("404", "<p class='note'>No such screen.</p>")));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      // Surface the error rather than a blank page — on stage a visible stack
      // beats a screen that silently shows nothing.
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page("error", "", panel("server error", `<pre>${String((err as Error).stack ?? err)}</pre>`)));
    }
  })();
});

server.listen(PORT, () => console.log(`console on http://localhost:${PORT}`));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => void closePool().then(() => process.exit(0)));
  });
}
