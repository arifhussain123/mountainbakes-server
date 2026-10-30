import Anthropic from '@anthropic-ai/sdk';

/**
 * Claude (Anthropic), for reading receipt photos (AI Expense Capture).
 *
 * Server-side only. The key is read from the environment on every call, so a
 * changed variable needs no deploy of code, and it never leaves this process:
 * no route returns it, no log line prints it.
 *
 *   ANTHROPIC_API_KEY   required; without it the feature answers 503
 *   AI_CAPTURE_MODEL    optional, default below
 *
 * One Messages API request with the photos inline as base64 and a JSON schema
 * for the reply (structured outputs), so the answer is JSON in a known shape
 * rather than prose. A request the model declines on safety grounds is re-run
 * on Anthropic's fallback model inside the same call (`fallbacks: "default"`).
 */

/** Override with AI_CAPTURE_MODEL rather than editing this. */
export const DEFAULT_AI_MODEL = 'claude-opus-5-5';

/** A run of ten photos can take most of a minute; anything past this has hung. */
const TIMEOUT_MS = 120_000;
/** The reply is a list of bills with their items — far below this. */
const MAX_TOKENS = 16_000;

const env = (k: string) => (process.env[k] ?? '').trim();

export interface AiConfig {
  apiKey: string;
  model: string;
}

export function aiConfig(): AiConfig | null {
  const apiKey = env('ANTHROPIC_API_KEY');
  if (!apiKey) return null;
  return { apiKey, model: env('AI_CAPTURE_MODEL') || DEFAULT_AI_MODEL };
}

export interface AiImage {
  mimeType: string;
  data: Buffer;
}

export interface AiRequest {
  prompt: string;
  images: AiImage[];
  /** A JSON Schema (structured-outputs subset) the reply must follow. */
  responseSchema: Record<string, unknown>;
}

/** What can go wrong, in words a finance user can act on. `status` is the HTTP status to answer with. */
export class AiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: 'not_configured' | 'timeout' | 'network' | 'quota' | 'blocked' | 'bad_reply' | 'upstream',
  ) {
    super(message);
  }
}

/** Send one request; the parsed JSON reply, or an AiError. */
export type AiCaller = (req: AiRequest, cfg: AiConfig) => Promise<unknown>;

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export const callClaude: AiCaller = async (req, cfg) => {
  // One retry for a dropped connection or an overloaded moment; more would
  // keep the user waiting several minutes on a page that says "reading".
  const client = new Anthropic({ apiKey: cfg.apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  let message: Anthropic.Beta.BetaMessage;
  try {
    message = await client.beta.messages.create({
      model: cfg.model,
      max_tokens: MAX_TOKENS,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: req.responseSchema },
      },
      messages: [{
        role: 'user',
        content: [
          ...req.images.map((img) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: img.mimeType as ImageMediaType, data: img.data.toString('base64') },
          })),
          { type: 'text' as const, text: req.prompt },
        ],
      }],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      throw new AiError('The AI took too long to read these receipts. Try again, or send fewer photos at once.', 504, 'timeout');
    }
    if (err instanceof Anthropic.APIConnectionError) {
      throw new AiError('Could not reach the AI service. Check the connection and try again.', 502, 'network');
    }
    if (err instanceof Anthropic.APIError) {
      // The upstream message can name the organisation or key; log it, never pass it on.
      console.error(`[ai-capture] Claude ${err.status ?? ''}: ${(err.message ?? '').slice(0, 300)}`);
      if (err instanceof Anthropic.RateLimitError || err.status === 529 || err instanceof Anthropic.InternalServerError) {
        throw new AiError('The AI service is busy or its quota is used up. Try again in a few minutes.', 503, 'quota');
      }
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError
          || err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError) {
        throw new AiError('The AI service refused the request. Ask the administrator to check the Anthropic key and model.', 502, 'upstream');
      }
      throw new AiError('The AI service had a problem. Try again shortly.', 502, 'upstream');
    }
    throw err;
  }

  if (message.stop_reason === 'refusal') {
    throw new AiError('The AI would not read these photos. Check they are receipts and try again.', 422, 'blocked');
  }
  const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  if (!text) {
    throw new AiError('The AI returned nothing for these photos. Try again with clearer photos.', 422, 'blocked');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError(
      message.stop_reason === 'max_tokens'
        ? 'These receipts were too long to read in one go. Send fewer photos at once.'
        : 'The AI reply could not be understood. Try again.',
      502,
      'bad_reply',
    );
  }
};

let caller: AiCaller = callClaude;

/** The caller in use (the real one unless a test swapped it). */
export function aiReader(): AiCaller {
  return caller;
}

/** Test seam: hand in a fake, or nothing to go back to the real API. */
export function setAiReader(next?: AiCaller): void {
  caller = next ?? callClaude;
}
