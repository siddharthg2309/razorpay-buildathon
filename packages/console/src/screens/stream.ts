import { page } from "../render.js";

/** 4c — the "watch it think" surface. */
export function streamScreen(): string {
  return page(
    "stream",
    "stream",
    `<h1>Live stream</h1>
     <p class="note">Same event source as the terminal view. Scrolling stops when you scroll up.</p>
     <div id="stream"></div>
     <script>
       const box = document.getElementById("stream");
       const pad = (s, n) => String(s).padEnd(n).slice(0, n);
       let pinned = true;
       box.addEventListener("scroll", () => {
         pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
       });
       const es = new EventSource("/events");
       es.onmessage = (m) => {
         const l = JSON.parse(m.data);
         const el = document.createElement("div");
         el.className = "s-" + l.kind;
         el.textContent = pad(l.caseId, 12) + pad(l.kind, 10) + l.text;
         box.appendChild(el);
         while (box.childNodes.length > 800) box.removeChild(box.firstChild);
         if (pinned) box.scrollTop = box.scrollHeight;
       };
     </script>`,
  );
}
