import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The Claude client of AI Expense Capture (services/ai/claude.ts), run for real
 * against a stand-in for the Anthropic API on localhost (ANTHROPIC_BASE_URL):
 * what is sent, and how each kind of answer comes back.
 */

interface Seen {
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

let server: Server;
let seen: Seen | null = null;
let answer: { status: number; body: unknown; headers?: Record<string, string> } = { status: 200, body: {} };

const message = (text: string, stop_reason = 'end_turn') => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: text ? [{ type: 'text', text }] : [],
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});

const apiError = (type: string, msg: string) => ({ type: 'error', error: { type, message: msg } });

const SCHEMA = { type: 'object', properties: {}, required: [], additionalProperties: false };
const request = () => ({
  prompt: 'Read these receipts.',
  images: [
    { mimeType: 'image/jpeg', data: Buffer.from('jpeg-bytes') },
    { mimeType: 'image/png', data: Buffer.from('png-bytes') },
  ],
  responseSchema: SCHEMA,
});
const cfg = { apiKey: 'sk-ant-test', model: 'claude-opus-5-5' };

let claude: typeof import('../ai/claude');

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen = { headers: req.headers, body: JSON.parse(raw || '{}') };
      res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env['ANTHROPIC_BASE_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  claude = await import('../ai/claude');
});

after(async () => {
  delete process.env['ANTHROPIC_BASE_URL'];
  await new Promise<void>((r) => server.close(() => r()));
});

describe('Claude receipt reader', () => {
  test('sends the photos first, the instructions last, and asks for JSON in the schema', async () => {
    answer = { status: 200, body: message('{"photos":[],"bills":[]}') };
    const out = await claude.callClaude(request(), cfg);
    assert.deepEqual(out, { photos: [], bills: [] });

    const { headers, body } = seen!;
    // SDK 1.x sends the key as a bearer token; older releases used x-api-key.
    assert.ok(headers['authorization'] === 'Bearer sk-ant-test' || headers['x-api-key'] === 'sk-ant-test');
    assert.match(String(headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
    assert.equal(body['model'], 'claude-opus-5-5');
    assert.equal(body['fallbacks'], 'default');
    assert.deepEqual(body['output_config'], { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } });
    assert.equal(body['thinking'], undefined);
    const content = (body['messages'] as { content: Record<string, unknown>[] }[])[0]!.content;
    assert.deepEqual(content.map((c) => c['type']), ['image', 'image', 'text']);
    assert.deepEqual(content[0]!['source'], { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('jpeg-bytes').toString('base64') });
    assert.equal((content[1]!['source'] as Record<string, unknown>)['media_type'], 'image/png');
    assert.equal(content[2]!['text'], 'Read these receipts.');
  });

  test('a declined request is a 422 the user can act on', async () => {
    answer = { status: 200, body: message('', 'refusal') };
    await assert.rejects(claude.callClaude(request(), cfg), (e: unknown) =>
      e instanceof claude.AiError && e.status === 422 && e.code === 'blocked');
  });

  test('a reply cut off at the token limit says to send fewer photos', async () => {
    answer = { status: 200, body: message('{"photos":[', 'max_tokens') };
    await assert.rejects(claude.callClaude(request(), cfg), (e: unknown) =>
      e instanceof claude.AiError && e.status === 502 && e.code === 'bad_reply' && /fewer photos/.test(e.message));
  });

  test('a wrong key is reported as refused, without the upstream wording', async () => {
    answer = { status: 401, body: apiError('authentication_error', 'invalid x-api-key sk-ant-…') };
    await assert.rejects(claude.callClaude(request(), cfg), (e: unknown) =>
      e instanceof claude.AiError && e.status === 502 && e.code === 'upstream'
      && /Anthropic key/.test(e.message) && !/x-api-key/.test(e.message));
  });

  test('rate limited or overloaded is "busy", a 503', async () => {
    for (const [status, type] of [[429, 'rate_limit_error'], [529, 'overloaded_error']] as const) {
      answer = { status, body: apiError(type, 'slow down'), headers: { 'retry-after': '0' } };
      await assert.rejects(claude.callClaude(request(), cfg), (e: unknown) =>
        e instanceof claude.AiError && e.status === 503 && e.code === 'quota', String(status));
    }
  });

  test('no key, no config; the model can be overridden', () => {
    const saved = { key: process.env['ANTHROPIC_API_KEY'], model: process.env['AI_CAPTURE_MODEL'] };
    try {
      delete process.env['ANTHROPIC_API_KEY'];
      assert.equal(claude.aiConfig(), null);
      process.env['ANTHROPIC_API_KEY'] = ' k ';
      delete process.env['AI_CAPTURE_MODEL'];
      assert.deepEqual(claude.aiConfig(), { apiKey: 'k', model: 'claude-opus-5-5' });
      process.env['AI_CAPTURE_MODEL'] = 'claude-sonnet-5-5';
      assert.equal(claude.aiConfig()!.model, 'claude-sonnet-5-5');
    } finally {
      if (saved.key === undefined) delete process.env['ANTHROPIC_API_KEY']; else process.env['ANTHROPIC_API_KEY'] = saved.key;
      if (saved.model === undefined) delete process.env['AI_CAPTURE_MODEL']; else process.env['AI_CAPTURE_MODEL'] = saved.model;
    }
  });
});
