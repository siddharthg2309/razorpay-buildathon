import { card, page, pageHead } from "../render.js";

/** Live — the same event source the terminal view reads. */
export function streamScreen(): string {
  return page(
    "Live activity",
    "/stream",
    `${pageHead("Live activity", "Scroll up to pause.")}
     ${card("Events", `<div id="stream"></div>`, "newest at the bottom", true)}
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
         el.innerHTML = pad(l.caseId, 12) + "<b>" + pad(l.kind, 10) + "</b>" + l.text;
         box.appendChild(el);
         while (box.childNodes.length > 800) box.removeChild(box.firstChild);
         if (pinned) box.scrollTop = box.scrollHeight;
       };
     <\/script>`,
  );
}
