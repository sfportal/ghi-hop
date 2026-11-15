// Cloudflare Worker: phục vụ PWA (thư mục public) và API tóm tắt (giữ khóa Claude ở máy chủ).
import Anthropic from "@anthropic-ai/sdk";
import { streamSummary } from "../public/prompts.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true, server: true, passcode: Boolean(env.APP_PASSCODE) });
    }

    if (url.pathname === "/api/summarize" && request.method === "POST") {
      if (env.APP_PASSCODE && request.headers.get("x-app-passcode") !== env.APP_PASSCODE) {
        return json({ error: "Sai mã truy cập" }, 401);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Dữ liệu không hợp lệ" }, 400);
      }
      const input = {
        mode: body.mode === "live" ? "live" : "final",
        title: String(body.title || "").slice(0, 300),
        startedAt: body.startedAt,
        segments: Array.isArray(body.segments) ? body.segments.slice(0, 20000) : [],
        notes: Array.isArray(body.notes) ? body.notes.slice(0, 2000) : [],
      };
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const enc = new TextEncoder();
      (async () => {
        try {
          await streamSummary(client, input, (t) => writer.write(enc.encode(t)));
        } catch (e) {
          await writer.write(enc.encode(`\n\n> Lỗi khi gọi Claude: ${e?.message || e}`));
        } finally {
          await writer.close();
        }
      })();
      return new Response(readable, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    return env.ASSETS.fetch(request);
  },
};
