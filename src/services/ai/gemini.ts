/**
 * Google Gemini, for reading receipt photos (AI Expense Capture).
 *
 * Server-side only. The key is read from the environment on every call, so a
 * changed variable needs no deploy of code, and it never leaves this process:
 * no route returns it, no log line prints it.
 *
 *   GEMINI_API_KEY   required; without it the feature answers 503
 *   GEMINI_MODEL     optional, default below
 *
 * Plain `fetch` against the Generative Language REST API (the WhatsApp and
 * geocode integrations do the same), with the images inline as base64 and a
 * response schema, so the reply is JSON in a known shape rather than prose.
 */

/** Override with GEMINI_MODEL rather than editing this. */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
/** A run of ten photos can take most of a minute; anything past this has hung. */
const TIMEOUT_MS = 90_000;

const env = (k: string) => (process.env[k] ?? '').trim();

export interface GeminiConfig {
  apiKey: string;
  model: string;
}

export function geminiConfig(): GeminiConfig | null {
  const apiKey = env('GEMINI_API_KEY');
  if (!apiKey) return null;
  return { apiKey, model: env('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL };
}

export interface GeminiImage {
  mimeType: string;
  data: Buffer;
}

export interface GeminiRequest {
  prompt: string;
  images: GeminiImage[];
  /** An OpenAPI-subset schema the reply must follow. */
  responseSchema: Record<string, unknown>;
}

/** What can go wrong, in words a finance user can act on. `status` is the HTTP status to answer with. */
export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: 'not_configured' | 'timeout' | 'network' | 'quota' | 'blocked' | 'bad_reply' | 'upstream',
  ) {
    super(message);
  }
}

/** Send one request; the parsed JSON reply, or a GeminiError. */
export type GeminiCaller = (req: GeminiRequest, cfg: GeminiConfig) => Promise<unknown>;

interface GenerateContentReply {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

export const callGemini: GeminiCaller = async (req, cfg) => {
  let res: Response;
  try {
    res = await fetch(`${ENDPOINT}/${encodeURIComponent(cfg.model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': cfg.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: req.prompt },
            ...req.images.map((img) => ({ inline_data: { mime_type: img.mimeType, data: img.data.toString('base64') } })),
          ],
        }],
        generationConfig: {
          // Reading, not writing: the same receipt should read the same way twice.
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: req.responseSchema,
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if ((err as Error).name === 'TimeoutError') {
      throw new GeminiError('The AI took too long to read these receipts. Try again, or send fewer photos at once.', 504, 'timeout');
    }
    throw new GeminiError('Could not reach the AI service. Check the connection and try again.', 502, 'network');
  }

  const json = (await res.json().catch(() => ({}))) as GenerateContentReply;
  if (!res.ok) {
    // The upstream message can name the project or key; log it, never pass it on.
    console.error(`[ai-capture] Gemini ${res.status} ${json.error?.status ?? ''}: ${(json.error?.message ?? '').slice(0, 300)}`);
    if (res.status === 429) throw new GeminiError('The AI service is busy or its quota is used up. Try again in a few minutes.', 503, 'quota');
    if (res.status === 400 || res.status === 403 || res.status === 401) {
      throw new GeminiError('The AI service refused the request. Ask the administrator to check the Gemini key and model.', 502, 'upstream');
    }
    throw new GeminiError('The AI service had a problem. Try again shortly.', 502, 'upstream');
  }
  if (json.promptFeedback?.blockReason) {
    throw new GeminiError('The AI would not read these photos. Check they are receipts and try again.', 422, 'blocked');
  }
  const candidate = json.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text) {
    throw new GeminiError(
      candidate?.finishReason === 'SAFETY'
        ? 'The AI would not read these photos. Check they are receipts and try again.'
        : 'The AI returned nothing for these photos. Try again with clearer photos.',
      422,
      'blocked',
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GeminiError(
      candidate?.finishReason === 'MAX_TOKENS'
        ? 'These receipts were too long to read in one go. Send fewer photos at once.'
        : 'The AI reply could not be understood. Try again.',
      502,
      'bad_reply',
    );
  }
};

let caller: GeminiCaller = callGemini;

/** The caller in use (the real one unless a test swapped it). */
export function gemini(): GeminiCaller {
  return caller;
}

/** Test seam: hand in a fake, or nothing to go back to the real API. */
export function setGeminiCaller(next?: GeminiCaller): void {
  caller = next ?? callGemini;
}
