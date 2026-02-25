import { z } from 'zod';
import crypto from 'crypto';
import db from '@/lib/db';
import { eq } from 'drizzle-orm';
import { chats } from '@/lib/db/schema';
import UploadManager from '@/lib/uploads/manager';

import { ChatTurnMessage } from '@/lib/types';
import { SearchSources } from '@/lib/agents/search/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * =========================
 * Request schema
 * =========================
 */
const messageSchema = z.object({
  messageId: z.string().min(1, 'Message ID is required'),
  chatId: z.string().min(1, 'Chat ID is required'),
  content: z.string().min(1, 'Message content is required'),
});

const bodySchema = z.object({
  message: messageSchema,
  optimizationMode: z.enum(['speed', 'balanced', 'quality'], {
    message: 'Optimization mode must be one of: speed, balanced, quality',
  }),
  sources: z.array(z.string()).optional().default([]),
  history: z.array(z.tuple([z.string(), z.string()])).optional().default([]),
  files: z.array(z.string()).optional().default([]),

  chatModel: z
    .object({
      providerId: z.string(),
      key: z.string(),
    })
    .passthrough(),
  embeddingModel: z
    .object({
      providerId: z.string(),
      key: z.string(),
    })
    .passthrough(),

  systemInstructions: z.string().nullable().optional().default(''),
});

type Body = z.infer<typeof bodySchema>;

const safeValidateBody = (data: unknown) => {
  const result = bodySchema.safeParse(data);
  if (!result.success) {
    return {
      success: false as const,
      error: result.error.issues.map((e: any) => ({
        path: e.path.join('.'),
        message: e.message,
      })),
    };
  }
  return { success: true as const, data: result.data };
};

/**
 * =========================
 * DB helper
 * =========================
 */
const ensureChatExists = async (input: {
  id: string;
  sources: SearchSources[];
  query: string;
  fileIds: string[];
}) => {
  try {
    const exists = await db.query.chats
      .findFirst({
        where: eq(chats.id, input.id),
      })
      .execute();

    if (!exists) {
      await db.insert(chats).values({
        id: input.id,
        createdAt: new Date().toISOString(),
        sources: input.sources,
        title: input.query,
        files: input.fileIds.map((id) => {
          return {
            fileId: id,
            name: UploadManager.getFile(id)?.name || 'Uploaded File',
          };
        }),
      });
    }
  } catch (err) {
    console.error('Failed to check/save chat:', err);
  }
};

/**
 * =========================
 * Streaming helpers
 * =========================
 */
type Block = {
  id: string;
  type: string;
  data: any;
};

const mkId = () => crypto.randomBytes(7).toString('hex');

const sseHeaders = {
  'Content-Type': 'text/event-stream',
  Connection: 'keep-alive',
  'Cache-Control': 'no-cache, no-transform',
};

function getEnv(name: string, fallback = '') {
  return process.env[name] ?? fallback;
}

async function writeLine(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  obj: any,
) {
  await writer.write(encoder.encode(JSON.stringify(obj) + '\n'));
}

/**
 * Parse stream from miroflow:
 * Supports both:
 *  - NDJSON: {"type":...}\n{"type":...}\n
 *  - SSE:    data: {"type":...}\n\n
 */
async function* streamJsonIterator(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';

  const parseMaybeJsonLine = (raw: string) => {
    let line = raw.trim();
    if (!line) return null;

    // ignore SSE meta lines
    if (line.startsWith(':')) return null;
    if (line.startsWith('event:')) return null;
    if (line.startsWith('id:')) return null;
    if (line.startsWith('retry:')) return null;

    // SSE data:
    if (line.startsWith('data:')) {
      line = line.slice(5).trim();
      if (!line) return null;
    }

    if (line === '[DONE]') return null;

    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });

    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const l of lines) {
      const obj = parseMaybeJsonLine(l);
      if (obj) yield obj;
    }
  }

  const tail = buf.trim();
  if (tail) {
    for (const l of tail.split('\n')) {
      const obj = parseMaybeJsonLine(l);
      if (obj) yield obj;
    }
  }
}

/**
 * =========================
 * Text sanitation
 * =========================
 */
const MCP_TAG_RE = /<use_mcp_tool>[\s\S]*?<\/use_mcp_tool>/gi;

function stripMcpTags(text: string): string {
  if (!text) return '';
  return text.replace(MCP_TAG_RE, '');
}

function stripMcpNakedTags(text: string): string {
  if (!text) return '';
  return text
    .replace(/<\/?server_name>/gi, '')
    .replace(/<\/?tool_name>/gi, '')
    .replace(/<\/?arguments>/gi, '')
    .replace(/<\/?use_mcp_tool>/gi, '');
}

function stripThinkTags(text: string): string {
  return String(text || '')
    .replace(/<think>/gi, '')
    .replace(/<\/think>/gi, '');
}

/**
 * ✅ Extract LAST \boxed{...} inner content.
 * - supports simple nested braces
 * - handles both \boxed and \\boxed
 */
function extractLastBoxedContent(text: string): string {
  if (!text) return '';
  const s = String(text);

  const findLast = (token: string) => {
    const idx = s.lastIndexOf(token);
    if (idx === -1) return '';

    let j = idx + token.length;
    while (j < s.length && /\s/.test(s[j])) j++;
    if (j >= s.length || s[j] !== '{') return '';

    let depth = 0;
    let k = j;
    const innerStart = j + 1;
    let innerEnd = -1;

    while (k < s.length) {
      const ch = s[k];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          innerEnd = k;
          break;
        }
      }
      k++;
    }

    if (innerEnd === -1) return '';
    return s.slice(innerStart, innerEnd);
  };

  // order matters
  return findLast('\\\\boxed') || findLast('\\boxed') || '';
}

/**
 * normalize thinking delta (avoid "one token per line")
 */
function normalizeThinkDelta(prev: string, delta: string): string {
  if (!delta) return '';
  if (!prev) return delta;

  const prevLast = prev.slice(-1);
  const nextFirst = delta.slice(0, 1);

  if (/\s/.test(prevLast) || /\s/.test(nextFirst)) return delta;

  const isAlphaNum = (ch: string) => /[A-Za-z0-9]/.test(ch);
  const isCJK = (ch: string) => /[\u4e00-\u9fff]/.test(ch);

  if (isCJK(prevLast) || isCJK(nextFirst)) return delta;
  if (isAlphaNum(prevLast) && isAlphaNum(nextFirst)) return ' ' + delta;

  return delta;
}

/**
 * =========================
 * miroflow adapter
 *
 * ✅ Strategy (boxed-only answer):
 * - Thinking block streams normally
 * - Answer text block stays EMPTY during streaming
 * - ONLY update Answer when FINAL contains \boxed{...}
 * - FINAL without boxed => do NOT write Answer (keep empty)
 * =========================
 */
async function runMiroflowAndStreamToClient(opts: {
  req: Request;
  body: Body;
  historyForMiroflow: ChatTurnMessage[];
  writer: WritableStreamDefaultWriter<Uint8Array>;
  encoder: TextEncoder;
}) {
  const { req, body, historyForMiroflow, writer, encoder } = opts;

  const endpoint = getEnv('MIROFLOW_ENDPOINT');
  if (!endpoint) {
    await writeLine(writer, encoder, { type: 'error', data: 'MIROFLOW_ENDPOINT is not set' });
    await writeLine(writer, encoder, { type: 'messageEnd' });
    return;
  }

  const apiKey = getEnv('MIROFLOW_API_KEY');

  const payload = {
    query: body.message.content,
    history: body.history,
    messages: historyForMiroflow,
    files: body.files,
    sources: body.sources,
    optimizationMode: body.optimizationMode,
    chatId: body.message.chatId,
    messageId: body.message.messageId,
    systemInstructions: body.systemInstructions || '',
    chatModel: body.chatModel,
    embeddingModel: body.embeddingModel,
    stream: true,
  };

  const mfRes = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    signal: req.signal,
    body: JSON.stringify(payload),
  });

  if (!mfRes.ok) {
    const errText = await mfRes.text().catch(() => '');
    await writeLine(writer, encoder, {
      type: 'error',
      data: errText || `miroflow request failed: HTTP ${mfRes.status}`,
    });
    await writeLine(writer, encoder, { type: 'messageEnd' });
    return;
  }

  if (!mfRes.body) {
    await writeLine(writer, encoder, { type: 'error', data: 'miroflow response has no body' });
    await writeLine(writer, encoder, { type: 'messageEnd' });
    return;
  }

  // create blocks ONCE
  const thinkingBlockId = mkId();
  const answerBlockId = mkId();

  await writeLine(writer, encoder, {
    type: 'block',
    block: { id: thinkingBlockId, type: 'thinking', data: '' } satisfies Block,
  });

  await writeLine(writer, encoder, {
    type: 'block',
    block: { id: answerBlockId, type: 'text', data: '' } satisfies Block,
  });

  let thinkBuf = '';
  let answerBuf = '';

  const pushThinkingUpdate = async () => {
    await writeLine(writer, encoder, {
      type: 'updateBlock',
      blockId: thinkingBlockId,
      patch: [{ op: 'replace', path: '/data', value: thinkBuf }],
    });
  };

  const pushAnswerUpdate = async () => {
    await writeLine(writer, encoder, {
      type: 'updateBlock',
      blockId: answerBlockId,
      patch: [{ op: 'replace', path: '/data', value: answerBuf }],
    });
  };

  const appendThinking = async (raw: string) => {
    // thinking: allow model's thinking text, but strip MCP + strip literal think tags
    const cleaned = stripThinkTags(stripMcpNakedTags(stripMcpTags(String(raw || ''))));
    if (!cleaned) return;
    const d = normalizeThinkDelta(thinkBuf, cleaned);
    thinkBuf += d;
    await pushThinkingUpdate();
  };

  const coerce = (v: any) => (typeof v === 'string' ? v : '');

  try {
    for await (const ev of streamJsonIterator(mfRes.body)) {
      const t = String(ev?.type || '').toLowerCase();

      if (t === 'error') {
        await writeLine(writer, encoder, {
          type: 'error',
          data: ev?.data || ev?.message || 'miroflow error',
        });
        await writeLine(writer, encoder, { type: 'messageEnd' });
        return;
      }

      if (t === 'researchcomplete') {
        await writeLine(writer, encoder, { type: 'researchComplete' });
        continue;
      }

      if (t === 'messageend') {
        await writeLine(writer, encoder, { type: 'messageEnd' });
        return;
      }

      // passthrough other blocks (sources/widgets)
      if (t === 'block' && ev?.block) {
        await writeLine(writer, encoder, { type: 'block', block: ev.block });
        continue;
      }

      // structured thinking events
      if (t === 'thinking') {
        const d = coerce(ev?.delta) || coerce(ev?.text) || coerce(ev?.data) || '';
        if (d) await appendThinking(d);
        continue;
      }

      if (t === 'thinking_end') {
        if (thinkBuf && !thinkBuf.endsWith('\n\n')) {
          thinkBuf += '\n\n';
          await pushThinkingUpdate();
        }
        continue;
      }

      // IMPORTANT: do NOT stream tokens into Answer
      if (t === 'token' || t === 'delta' || t === 'text') {
        continue;
      }

      // FINAL: boxed-only answer
      if (t === 'final' || t === 'answer' || t === 'result' || t === 'output') {
        const rawFinal =
          coerce(ev?.text) || coerce(ev?.final) || coerce(ev?.answer) || coerce(ev?.result) || '';

        // 1) remove MCP only; keep \boxed wrapper for extraction; keep think tags (doesn't matter)
        const noMcp = stripMcpNakedTags(stripMcpTags(String(rawFinal || '')));

        // 2) extract boxed inner content
        const boxed = extractLastBoxedContent(noMcp);

        // 3) boxed-only: only update Answer if boxed exists
        const finalAnswer = stripThinkTags(stripMcpNakedTags(stripMcpTags(boxed))).trim();
        if (finalAnswer) {
          answerBuf = finalAnswer;
          await pushAnswerUpdate();
        }

        continue;
      }
    }
  } catch (e: any) {
    await writeLine(writer, encoder, {
      type: 'error',
      data: e?.message || 'Failed while reading miroflow stream',
    });
    await writeLine(writer, encoder, { type: 'messageEnd' });
    return;
  }

  await writeLine(writer, encoder, { type: 'researchComplete' });
  await writeLine(writer, encoder, { type: 'messageEnd' });
}

/**
 * =========================
 * Main POST handler
 * =========================
 */
export const POST = async (req: Request) => {
  const responseStream = new TransformStream();
  const writer = responseStream.writable.getWriter();
  const encoder = new TextEncoder();

  const raw = await req.json().catch(() => null);
  const parsed = safeValidateBody(raw);

  if (!parsed.success) {
    return Response.json(
      { message: `Invalid request body: ${JSON.stringify(parsed.error)}` },
      { status: 400 },
    );
  }

  const body = parsed.data as Body;

  if (!body.message.content || body.message.content.trim() === '') {
    return Response.json({ message: 'Please provide a message to process' }, { status: 400 });
  }

  const historyForMiroflow: ChatTurnMessage[] = body.history.map((msg) =>
    msg[0] === 'human' ? { role: 'user', content: msg[1] } : { role: 'assistant', content: msg[1] },
  );

  ensureChatExists({
    id: body.message.chatId,
    sources: body.sources as SearchSources[],
    fileIds: body.files,
    query: body.message.content,
  });

  req.signal.addEventListener('abort', () => {
    try {
      writer.close();
    } catch {}
  });

  (async () => {
    try {
      await runMiroflowAndStreamToClient({
        req,
        body,
        historyForMiroflow,
        writer,
        encoder,
      });
    } catch (err: any) {
      try {
        await writeLine(writer, encoder, {
          type: 'error',
          data: err?.message || 'Internal error while streaming',
        });
        await writeLine(writer, encoder, { type: 'messageEnd' });
      } catch {}
    } finally {
      try {
        await writer.close();
      } catch {}
    }
  })();

  return new Response(responseStream.readable, { headers: sseHeaders });
};