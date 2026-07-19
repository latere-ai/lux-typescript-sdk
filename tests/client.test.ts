import { afterAll, describe, expect, test } from "bun:test";
import {
  LuxClient,
  LuxError,
  LuxStreamError,
  assistantText,
  userText,
  type LuxEvent,
} from "../src/index";

// A programmable fake gateway: each test registers the next handler.
let handler: (req: Request) => Response | Promise<Response> = () =>
  new Response("unset", { status: 500 });
const server = Bun.serve({
  port: 0,
  fetch: (req) => handler(req),
});
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${server.port}`;

const okResponse = JSON.stringify({
  id: "msg_1",
  model: "claude-sonnet-5",
  blocks: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 3, output_tokens: 2 },
});

const streamBody = [
  `event: message_start\ndata: {"type":"message_start","id":"msg_1","model":"m","index":0,"usage":{"input_tokens":3,"output_tokens":0}}`,
  `event: block_start\ndata: {"type":"block_start","index":0,"block":{"type":"text"}}`,
  `event: text_delta\ndata: {"type":"text_delta","index":0,"delta":"hel"}`,
  `event: ping\ndata: {}`, // unknown frame: skipped
  `data: [DONE]`, // unnamed frame: skipped
  `event: text_delta\ndata: {"index":0,"delta":"lo"}`, // type filled from name
  `event: block_stop\ndata: {"type":"block_stop","index":0}`,
  `event: message_delta\ndata: {"type":"message_delta","index":0,"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":2}}`,
  `event: message_stop\ndata: {"type":"message_stop","index":0}`,
].join("\n\n") + "\n\n";

describe("generate", () => {
  test("happy path with auth, loss, forced stream off", async () => {
    let gotAuth = "";
    let gotPath = "";
    let gotBody = "";
    handler = async (req) => {
      gotAuth = req.headers.get("Authorization") ?? "";
      gotPath = new URL(req.url).pathname;
      gotBody = await req.text();
      return new Response(okResponse, {
        headers: { "Content-Type": "application/json", "X-Lux-Compat-Loss": "top_k,thinking" },
      });
    };
    const c = new LuxClient(base + "/", { apiKey: "lux_k1" });
    const res = await c.generate({
      model: "claude-sonnet-5",
      messages: [userText("hi"), assistantText("prior")],
      stream: true, // must be forced off
    });
    expect(gotPath).toBe("/lux/v1/generate");
    expect(gotAuth).toBe("Bearer lux_k1");
    expect(gotBody).toContain('"stream":false');
    expect(res.blocks[0]!.text).toBe("hello");
    expect(res.stop_reason).toBe("end_turn");
    expect(res.usage.input_tokens).toBe(3);
    expect(res.loss).toEqual(["top_k", "thinking"]);
  });

  test("error envelope decodes into LuxError", async () => {
    handler = () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "slow down", request_id: "req_9" },
        }),
        { status: 429 },
      );
    const c = new LuxClient(base);
    try {
      await c.generate({ model: "m", messages: [userText("x")] });
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toBeInstanceOf(LuxError);
      const e = err as LuxError;
      expect(e.status).toBe(429);
      expect(e.code).toBe("rate_limit_error");
      expect(e.requestId).toBe("req_9");
      expect(e.message).toContain("slow down");
    }
  });

  test("opaque error body degrades to raw text", async () => {
    handler = () => new Response("upstream fell over", { status: 502 });
    const c = new LuxClient(base);
    try {
      await c.generate({ model: "m", messages: [userText("x")] });
      throw new Error("unreachable");
    } catch (err) {
      const e = err as LuxError;
      expect(e.status).toBe(502);
      expect(e.code).toBe("");
      expect(e.message).toContain("upstream fell over");
    }
  });

  test("cost tags serialize sorted into Lux-Cost-Tag, absent when unset", async () => {
    let gotTag: string | null = "sentinel";
    let gotBody = "";
    handler = async (req) => {
      gotTag = req.headers.get("Lux-Cost-Tag");
      gotBody = await req.text();
      return new Response(okResponse, { headers: { "Content-Type": "application/json" } });
    };
    const c = new LuxClient(base);
    // Insertion order (tenant, project) differs from sorted order to
    // prove the header is sorted, not just echoed.
    await c.generate({
      model: "m",
      messages: [userText("x")],
      costTags: { tenant: "acme", project: "web" },
    });
    expect(gotTag).toBe("project=web,tenant=acme");
    // Cost tags travel as a header, never in the wire body.
    expect(gotBody).not.toContain("costTags");

    // Absent when unset.
    await c.generate({ model: "m", messages: [userText("x")] });
    expect(gotTag).toBeNull();
  });

  test("client-default cost tags apply and per-call overrides", async () => {
    let gotTag: string | null = null;
    handler = (req) => {
      gotTag = req.headers.get("Lux-Cost-Tag");
      return new Response(okResponse, { headers: { "Content-Type": "application/json" } });
    };
    const c = new LuxClient(base, { costTags: { tenant: "default" } });
    await c.generate({ model: "m", messages: [userText("x")] });
    expect(gotTag).toBe("tenant=default");

    await c.generate({ model: "m", messages: [userText("x")], costTags: { tenant: "acme" } });
    expect(gotTag).toBe("tenant=acme");
  });

  test("tokenSource wins over apiKey", async () => {
    let gotAuth = "";
    handler = (req) => {
      gotAuth = req.headers.get("Authorization") ?? "";
      return new Response(okResponse, { headers: { "Content-Type": "application/json" } });
    };
    const c = new LuxClient(base, { apiKey: "static", tokenSource: async () => "jwt-1" });
    await c.generate({ model: "m", messages: [userText("x")] });
    expect(gotAuth).toBe("Bearer jwt-1");
  });
});

describe("countTokens", () => {
  test("native count", async () => {
    let gotPath = "";
    handler = (req) => {
      gotPath = new URL(req.url).pathname;
      return new Response(JSON.stringify({ input_tokens: 42 }), {
        headers: { "Content-Type": "application/json" },
      });
    };
    const c = new LuxClient(base, { apiKey: "k" });
    const tc = await c.countTokens({ model: "m", messages: [userText("hi")] });
    expect(gotPath).toBe("/lux/v1/count_tokens");
    expect(tc.input_tokens).toBe(42);
    expect(tc.estimated).toBe(false);
  });

  test("estimated count is flagged", async () => {
    handler = () =>
      new Response(JSON.stringify({ input_tokens: 7 }), {
        headers: { "Content-Type": "application/json", "X-Lux-Compat-Estimated": "true" },
      });
    const c = new LuxClient(base);
    const tc = await c.countTokens({ model: "m", messages: [userText("x")] });
    expect(tc.input_tokens).toBe(7);
    expect(tc.estimated).toBe(true);
  });
});

describe("stream", () => {
  test("full grammar with skips, type fill, and loss", async () => {
    let gotBody = "";
    handler = async (req) => {
      gotBody = await req.text();
      return new Response(streamBody, {
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "X-Lux-Compat-Loss": "top_k" },
      });
    };
    const c = new LuxClient(base, { apiKey: "k" });
    const st = await c.stream({ model: "m", messages: [userText("x")] });
    expect(gotBody).toContain('"stream":true');
    expect(st.loss).toEqual(["top_k"]);

    let text = "";
    const types: string[] = [];
    for await (const ev of st) {
      types.push(ev.type);
      if (ev.type === "text_delta") {
        text += ev.delta ?? "";
      }
    }
    expect(text).toBe("hello");
    expect(types).toEqual([
      "message_start",
      "block_start",
      "text_delta",
      "text_delta",
      "block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  test("mid-stream error frame throws LuxStreamError", async () => {
    handler = () =>
      new Response(
        `event: message_start\ndata: {"type":"message_start","id":"m1","index":0}\n\n` +
          `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"busy"}}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    const c = new LuxClient(base);
    const st = await c.stream({ model: "m", messages: [userText("x")] });
    const events: LuxEvent[] = [];
    try {
      for await (const ev of st) {
        events.push(ev);
      }
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toBeInstanceOf(LuxStreamError);
      expect((err as LuxStreamError).code).toBe("overloaded_error");
    }
    expect(events.length).toBe(1);
  });

  test("opaque mid-stream error keeps the raw payload", async () => {
    handler = () =>
      new Response(`event: error\ndata: it broke\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    const c = new LuxClient(base);
    const st = await c.stream({ model: "m", messages: [userText("x")] });
    try {
      for await (const _ of st) {
        // no events expected
      }
      throw new Error("unreachable");
    } catch (err) {
      expect((err as LuxStreamError).message).toContain("it broke");
    }
  });

  test("non-SSE response is rejected", async () => {
    handler = () => new Response(okResponse, { headers: { "Content-Type": "application/json" } });
    const c = new LuxClient(base);
    await expect(c.stream({ model: "m", messages: [userText("x")] })).rejects.toBeInstanceOf(
      LuxError,
    );
  });

  test("error status before the stream starts", async () => {
    handler = () =>
      new Response(JSON.stringify({ type: "error", error: { type: "permission_error", message: "no" } }), {
        status: 403,
      });
    const c = new LuxClient(base);
    try {
      await c.stream({ model: "m", messages: [userText("x")] });
      throw new Error("unreachable");
    } catch (err) {
      expect((err as LuxError).status).toBe(403);
    }
  });

  test("unterminated final frame still yields", async () => {
    handler = () =>
      new Response(
        `event: message_start\ndata: {"type":"message_start","id":"m1","index":0}\n\n` +
          `event: message_stop\ndata: {"type":"message_stop","index":0}`, // no trailing blank line
        { headers: { "Content-Type": "text/event-stream" } },
      );
    const c = new LuxClient(base);
    const st = await c.stream({ model: "m", messages: [userText("x")] });
    const types: string[] = [];
    for await (const ev of st) {
      types.push(ev.type);
    }
    expect(types).toEqual(["message_start", "message_stop"]);
  });

  test("close releases the stream early", async () => {
    handler = () =>
      new Response(streamBody, { headers: { "Content-Type": "text/event-stream" } });
    const c = new LuxClient(base);
    const st = await c.stream({ model: "m", messages: [userText("x")] });
    await st.close();
  });
});
