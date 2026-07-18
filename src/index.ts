// The TypeScript client for the Lux gateway's native dialect: one
// typed request/response/stream shape for every model Lux routes,
// POST {base}/lux/v1/generate. Zero dependencies; needs only fetch +
// ReadableStream (Node >= 18, Bun, Deno, browsers). Field names are
// the wire's snake_case, verbatim.

export type Role = "user" | "assistant";
export type BlockType =
  | "text"
  | "image"
  | "tool_use"
  | "tool_result"
  | "thinking"
  | "redacted_thinking";
export type ToolChoiceMode = "auto" | "any" | "none" | "tool";
export type Effort = "minimal" | "low" | "medium" | "high" | (string & {});
export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "refusal"
  | (string & {});
export type EventType =
  | "message_start"
  | "block_start"
  | "text_delta"
  | "args_delta"
  | "thinking_delta"
  | "signature_delta"
  | "block_stop"
  | "message_delta"
  | "message_stop";

export interface Image {
  media_type?: string;
  data?: string;
  url?: string;
}

export interface ToolUse {
  id: string;
  name: string;
  args?: unknown;
}

export interface ToolResult {
  tool_use_id: string;
  blocks?: Block[];
  is_error?: boolean;
}

export interface Block {
  type: BlockType;
  text?: string;
  image?: Image;
  tool_use?: ToolUse;
  tool_result?: ToolResult;
  signature?: string;
  redacted?: string;
  cache_hint?: boolean;
}

export interface Message {
  role: Role;
  blocks: Block[];
}

export interface Tool {
  name: string;
  description?: string;
  input_schema: unknown;
}

export interface ToolChoice {
  mode: ToolChoiceMode;
  name?: string;
  disable_parallel?: boolean;
}

export interface Reasoning {
  effort?: Effort;
  budget_tokens?: number;
}

export interface ResponseSchema {
  name?: string;
  description?: string;
  schema: unknown;
  strict?: boolean;
}

export interface LuxRequest {
  model: string;
  system?: Block[];
  messages: Message[];
  tools?: Tool[];
  tool_choice?: ToolChoice;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  reasoning?: Reasoning;
  schema?: ResponseSchema;
  user_id?: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_write_input_tokens?: number;
  reasoning_tokens?: number;
}

export interface LuxResponse {
  id: string;
  model: string;
  blocks: Block[];
  stop_reason: StopReason;
  stop_sequence?: string;
  usage: Usage;
}

export interface LuxEvent {
  type: EventType;
  id?: string;
  model?: string;
  index: number;
  block?: Block;
  delta?: string;
  stop_reason?: StopReason;
  stop_sequence?: string;
  usage?: Usage;
}

export interface TokenCount {
  input_tokens: number;
  /** True when the target has no native tokenizer endpoint and the
   * count is a heuristic estimate. */
  estimated: boolean;
}

/** A completed non-streaming call: the response plus the loss report
 * (request fields the backend dialect could not represent). */
export interface LuxResult extends LuxResponse {
  loss: string[];
}

/** A non-2xx gateway response, decoded from the error envelope. */
export class LuxError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  constructor(status: number, code: string, message: string, requestId = "") {
    super(code ? `lux: ${status} ${code}: ${message}` : `lux: ${status}: ${message}`);
    this.name = "LuxError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/** A mid-stream `event: error` frame from the gateway. */
export class LuxStreamError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(code ? `lux: stream error (${code}): ${message}` : `lux: stream error: ${message}`);
    this.name = "LuxStreamError";
    this.code = code;
  }
}

/** One-block user turn. */
export function userText(text: string): Message {
  return { role: "user", blocks: [{ type: "text", text }] };
}

/** One-block assistant turn. */
export function assistantText(text: string): Message {
  return { role: "assistant", blocks: [{ type: "text", text }] };
}

export interface LuxClientOptions {
  /** Static bearer: a Lux virtual key (lux_...) or any accepted token. */
  apiKey?: string;
  /** Per-call bearer (e.g. a rotating JWT); wins over apiKey. */
  tokenSource?: () => Promise<string> | string;
  /** Override the fetch implementation (tests, custom agents). */
  fetch?: typeof fetch;
}

const GENERATE_PATH = "/lux/v1/generate";
const COUNT_TOKENS_PATH = "/lux/v1/count_tokens";
const LOSS_HEADER = "X-Lux-Compat-Loss";
const ESTIMATED_HEADER = "X-Lux-Compat-Estimated";

/** A live event stream. Iterate with `for await`; iteration ends
 * after message_stop. `loss` lists request fields the backend dialect
 * could not represent. */
export interface LuxStream extends AsyncIterable<LuxEvent> {
  readonly loss: string[];
  /** Release the underlying connection early. */
  close(): Promise<void>;
}

export class LuxClient {
  private readonly baseURL: string;
  private readonly opts: LuxClientOptions;
  private readonly fetchFn: typeof fetch;

  constructor(baseURL: string, opts: LuxClientOptions = {}) {
    this.baseURL = baseURL.replace(/\/+$/, "");
    this.opts = opts;
    this.fetchFn = opts.fetch ?? fetch;
  }

  /** Non-streaming call; the request's stream flag is overridden off. */
  async generate(req: LuxRequest): Promise<LuxResult> {
    const resp = await this.post(GENERATE_PATH, { ...req, stream: false });
    const body = (await resp.json()) as LuxResponse;
    return { ...body, loss: parseLoss(resp) };
  }

  /** Token count without spending output tokens; no spend gates run. */
  async countTokens(req: LuxRequest): Promise<TokenCount> {
    const resp = await this.post(COUNT_TOKENS_PATH, { ...req, stream: false });
    const body = (await resp.json()) as { input_tokens: number };
    return {
      input_tokens: body.input_tokens,
      estimated: resp.headers.get(ESTIMATED_HEADER) === "true",
    };
  }

  /** Streaming call; the request's stream flag is overridden on. */
  async stream(req: LuxRequest): Promise<LuxStream> {
    const resp = await this.post(GENERATE_PATH, { ...req, stream: true });
    const ct = resp.headers.get("Content-Type") ?? "";
    if (!ct.startsWith("text/event-stream")) {
      throw new LuxError(resp.status, "", `expected an event stream, got ${JSON.stringify(ct)}`);
    }
    if (!resp.body) {
      throw new LuxError(resp.status, "", "response has no body");
    }
    const loss = parseLoss(resp);
    const reader = resp.body.getReader();
    return {
      loss,
      close: async () => {
        await reader.cancel();
      },
      [Symbol.asyncIterator]: () => sseEvents(reader),
    };
  }

  private async post(path: string, payload: unknown): Promise<globalThis.Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let bearer = this.opts.apiKey ?? "";
    if (this.opts.tokenSource) {
      bearer = await this.opts.tokenSource();
    }
    if (bearer) {
      headers["Authorization"] = `Bearer ${bearer}`;
    }
    const resp = await this.fetchFn(this.baseURL + path, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw await decodeError(resp);
    }
    return resp;
  }
}

function parseLoss(resp: globalThis.Response): string[] {
  const v = resp.headers.get(LOSS_HEADER);
  return v ? v.split(",") : [];
}

async function decodeError(resp: globalThis.Response): Promise<LuxError> {
  const raw = await resp.text();
  try {
    const wire = JSON.parse(raw) as {
      error?: { type?: string; message?: string; request_id?: string };
    };
    const e = wire.error;
    if (e && (e.type || e.message)) {
      return new LuxError(resp.status, e.type ?? "", e.message ?? "", e.request_id ?? "");
    }
  } catch {
    // fall through to the opaque form
  }
  return new LuxError(resp.status, "", raw.trim());
}

const VALID_EVENTS = new Set<string>([
  "message_start",
  "block_start",
  "text_delta",
  "args_delta",
  "thinking_delta",
  "signature_delta",
  "block_stop",
  "message_delta",
  "message_stop",
]);

/** Parse the lux SSE stream (the IR event grammar) into events.
 * Unknown event names are skipped (forward compatibility); an
 * `event: error` frame throws LuxStreamError. */
async function* sseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<LuxEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const ev = parseFrame(frame);
        if (ev !== null) {
          yield ev;
        }
      }
    }
    // A final unterminated frame still parses (stream cut early).
    if (buf.trim() !== "") {
      const ev = parseFrame(buf);
      if (ev !== null) {
        yield ev;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function parseFrame(frame: string): LuxEvent | null {
  let name = "";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      name = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  const data = dataLines.join("\n");
  if (name === "error") {
    try {
      const wire = JSON.parse(data) as { error?: { type?: string; message?: string } };
      const e = wire.error;
      if (e && (e.type || e.message)) {
        throw new LuxStreamError(e.type ?? "", e.message ?? "");
      }
    } catch (err) {
      if (err instanceof LuxStreamError) {
        throw err;
      }
    }
    throw new LuxStreamError("", data);
  }
  if (!VALID_EVENTS.has(name)) {
    return null;
  }
  const ev = JSON.parse(data) as LuxEvent;
  if (!ev.type) {
    ev.type = name as EventType;
  }
  return ev;
}
