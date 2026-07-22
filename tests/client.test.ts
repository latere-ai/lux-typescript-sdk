import { afterAll, describe, expect, test } from "bun:test";
import {
  LuxClient,
  LuxError,
  LuxStreamError,
  assistantText,
  userText,
  type LuxEvent,
  ENV_BASE_URL,
  ENV_API_KEY,
  DEFAULT_BASE_URL,
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
    let gotTag = "unset";
    handler = (req) => {
      gotTag = req.headers.get("Lux-Cost-Tag") ?? "";
      return new Response(okResponse, { headers: { "Content-Type": "application/json" } });
    };
    const c = new LuxClient(base, { costTags: { tenant: "default" } });
    await c.generate({ model: "m", messages: [userText("x")] });
    expect(gotTag).toBe("tenant=default");

    await c.generate({ model: "m", messages: [userText("x")], costTags: { tenant: "acme" } });
    expect(gotTag).toBe("tenant=acme");
  });

  // The wire form has no escaping: the gateway splits the header on ","
  // then cuts on "=". A "," or "=" inside a value therefore does not fail
  // loudly, it silently becomes extra tags, so the client must reject it.
  test("cost tags with , or = in a value are rejected", async () => {
    // "unset" rather than null: the assertion is that the handler never
    // ran at all, i.e. nothing was put on the wire.
    let gotTag = "unset";
    handler = (req) => {
      gotTag = req.headers.get("Lux-Cost-Tag") ?? "";
      return new Response(okResponse, { headers: { "Content-Type": "application/json" } });
    };
    const c = new LuxClient(base);
    await expect(
      c.generate({ model: "m", messages: [userText("x")], costTags: { a: "b,c=d" } }),
    ).rejects.toBeInstanceOf(LuxError);
    expect(gotTag).toBe("unset");

    // The same holds for a key, and for characters outside the charset.
    await expect(
      c.generate({ model: "m", messages: [userText("x")], costTags: { "a=b": "c" } }),
    ).rejects.toBeInstanceOf(LuxError);
    await expect(
      c.generate({ model: "m", messages: [userText("x")], costTags: { tenant: "acme corp" } }),
    ).rejects.toBeInstanceOf(LuxError);
    // The error names the offending key so the caller can find it.
    await expect(
      c.generate({ model: "m", messages: [userText("x")], costTags: { tenant: "a,b" } }),
    ).rejects.toThrow(/tenant/);
  });

  // Two distinct tag maps must never produce the same header, or the
  // gateway attributes spend to dimensions the caller never asked for.
  test("cost tag serialization is injective", async () => {
    const headerFor = async (tags: Record<string, string>) => {
      let gotTag = "unset";
      handler = (req) => {
        gotTag = req.headers.get("Lux-Cost-Tag") ?? "";
        return new Response(okResponse, { headers: { "Content-Type": "application/json" } });
      };
      const c = new LuxClient(base);
      try {
        await c.generate({ model: "m", messages: [userText("x")], costTags: tags });
      } catch (err) {
        return `rejected: ${(err as Error).message}`;
      }
      return gotTag;
    };
    const collided = await headerFor({ a: "b,c=d" });
    const honest = await headerFor({ a: "b", c: "d" });
    expect(honest).toBe("a=b,c=d");
    expect(collided).not.toBe(honest);
  });

  test("cost tag bounds are enforced", async () => {
    let gotTag = "unset";
    handler = (req) => {
      gotTag = req.headers.get("Lux-Cost-Tag") ?? "";
      return new Response(okResponse, { headers: { "Content-Type": "application/json" } });
    };
    const c = new LuxClient(base);
    const reject = (tags: Record<string, string>) =>
      expect(
        c.generate({ model: "m", messages: [userText("x")], costTags: tags }),
      ).rejects.toBeInstanceOf(LuxError);

    // More than 8 dimensions.
    const nine: Record<string, string> = {};
    for (let i = 0; i < 9; i++) {
      nine[`k${i}`] = "v";
    }
    await reject(nine);

    // A 65-byte key; 64 is the limit.
    await reject({ ["k".repeat(65)]: "v" });
    // A 129-byte value; 128 is the limit.
    await reject({ k: "v".repeat(129) });
    // Bounds are in bytes, not UTF-16 units: 33 3-byte runes is 99 bytes
    // of key, past the 64-byte limit even though .length is 33. (It is
    // also out of charset, which is the error the caller sees first.)
    await reject({ ["é".repeat(33)]: "v" });
    // Empty key or value.
    await reject({ "": "v" });
    await reject({ k: "" });
    expect(gotTag).toBe("unset");

    // The boundary values themselves pass.
    await c.generate({
      model: "m",
      messages: [userText("x")],
      costTags: { ["k".repeat(64)]: "v".repeat(128) },
    });
    expect(gotTag).toBe(`${"k".repeat(64)}=${"v".repeat(128)}`);

    // Values may carry ":" and "/", which keys may not.
    await c.generate({
      model: "m",
      messages: [userText("x")],
      costTags: { "svc.name-1_2": "team/web:prod" },
    });
    expect(gotTag).toBe("svc.name-1_2=team/web:prod");
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

  // SSE line terminators are CR, LF, or CRLF. luxd emits LF, but an
  // intermediary or a non-luxd producer may not, and the frame must
  // parse identically either way.
  test("CRLF-delimited frames parse into the same events", async () => {
    handler = () =>
      new Response(streamBody.replace(/\n/g, "\r\n"), {
        headers: { "Content-Type": "text/event-stream" },
      });
    const c = new LuxClient(base);
    const st = await c.stream({ model: "m", messages: [userText("x")] });
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

  test("a malformed data payload surfaces as LuxStreamError", async () => {
    handler = () =>
      new Response(`event: text_delta\ndata: {"index":0,\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    const c = new LuxClient(base);
    const st = await c.stream({ model: "m", messages: [userText("x")] });
    try {
      for await (const _ of st) {
        throw new Error("unreachable");
      }
      throw new Error("unreachable");
    } catch (err) {
      expect(err).toBeInstanceOf(LuxStreamError);
      expect((err as LuxStreamError).message).toContain("malformed");
    }
  });

  test("comment keep-alive lines are ignored", async () => {
    handler = () =>
      new Response(
        `: ping\n\n` +
          `event: message_start\n: mid-frame comment\ndata: {"type":"message_start","index":0}\n\n` +
          `:\n\n` +
          `event: message_stop\ndata: {"type":"message_stop","index":0}\n\n`,
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

  // A streaming client that only yields at EOF is not streaming. The
  // frame must surface while the connection is still open.
  // The body is fed directly rather than through the fake gateway: the
  // HTTP layer coalesces small writes, which would hide the property
  // under test.
  test("events are delivered before the stream ends", async () => {
    const enc = new TextEncoder();
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    // Cast because `typeof fetch` carries Bun's `preconnect` property,
    // which a plain function stub has no reason to implement.
    const stub = async () =>
      new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    const c = new LuxClient(base, { fetch: stub as unknown as typeof fetch });
    const st = await c.stream({ model: "m", messages: [userText("x")] });
    const it = st[Symbol.asyncIterator]();
    const pending = it.next();
    ctrl.enqueue(enc.encode(`event: message_start\r\ndata: {"type":"message_start","index":0}\r\n\r\n`));
    const first = await pending; // hangs if the parser buffers to EOF
    expect(first.done).toBe(false);
    expect(first.value?.type).toBe("message_start");
    ctrl.close();
    await st.close();
  });

  test("close releases the stream early", async () => {
    handler = () =>
      new Response(streamBody, { headers: { "Content-Type": "text/event-stream" } });
    const c = new LuxClient(base);
    const st = await c.stream({ model: "m", messages: [userText("x")] });
    await st.close();
  });
});

// The load-bearing compatibility property of the environment fallback is
// that it fills only what the caller left unset. Every existing call site
// passes an explicit base and credential, so if the environment could
// override either, exporting LUX_BASE_URL in a shell would silently
// redirect programs that never opted in.
describe("environment fallback", () => {
  const saved = { base: process.env[ENV_BASE_URL], key: process.env[ENV_API_KEY] };
  const setEnv = (b?: string, k?: string) => {
    if (b === undefined) delete process.env[ENV_BASE_URL];
    else process.env[ENV_BASE_URL] = b;
    if (k === undefined) delete process.env[ENV_API_KEY];
    else process.env[ENV_API_KEY] = k;
  };
  afterAll(() => setEnv(saved.base, saved.key));

  // The credential is only observable where it lands, on the wire.
  const authFor = async (c: LuxClient) => {
    let gotAuth = "";
    handler = (req) => {
      gotAuth = req.headers.get("Authorization") ?? "";
      return new Response(okResponse, { headers: { "content-type": "application/json" } });
    };
    await c.generate({ model: "m", messages: [userText("hi")] });
    return gotAuth;
  };

  test("explicit arguments beat the environment", async () => {
    setEnv("https://env.example", "lux_from_env");
    expect(await authFor(new LuxClient(base, { apiKey: "lux_from_arg" }))).toBe(
      "Bearer lux_from_arg",
    );
  });

  test("the environment fills what was omitted", async () => {
    setEnv(base, "lux_from_env");
    expect(await authFor(new LuxClient())).toBe("Bearer lux_from_env");
  });

  // A tokenSource is a credential, so the env key must not be read at
  // all; otherwise a stale export would shadow a live token provider.
  test("a tokenSource suppresses the environment key", async () => {
    setEnv(base, "lux_from_env");
    expect(await authFor(new LuxClient(undefined, { tokenSource: () => "live" }))).toBe(
      "Bearer live",
    );
  });

  // An unset credential must stay unset: defaulting to unauthenticated
  // would turn a misspelled variable into a confusing 401.
  test("a missing credential stays empty", async () => {
    setEnv(base, undefined);
    expect(await authFor(new LuxClient())).toBe("");
  });

  // Constructed only, never called: these must not reach the public URL.
  test("an unset base falls back to the public gateway", () => {
    setEnv(undefined, undefined);
    expect(new LuxClient()["baseURL"]).toBe(DEFAULT_BASE_URL);
  });

  // Trailing slashes are trimmed on the env path too, or every request
  // would carry a doubled separator.
  test("the environment base is trimmed", () => {
    setEnv("https://env.example/", undefined);
    expect(new LuxClient()["baseURL"]).toBe("https://env.example");
  });
});
