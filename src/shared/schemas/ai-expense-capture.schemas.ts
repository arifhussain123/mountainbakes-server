import { z } from 'zod';
import { AI_CAPTURE_MAX_PHOTOS } from '../types/ai-expense-capture.types';

/** `POST /api/finance/ai-capture/analyze`: the caller's own staged receipt photos. */
export const AnalyzeReceiptsSchema = z.object({
  attachmentIds: z
    .array(z.string().uuid())
    .min(1, 'Add at least one receipt photo')
    .max(AI_CAPTURE_MAX_PHOTOS, `At most ${AI_CAPTURE_MAX_PHOTOS} photos can be read at once`),
});

export type AnalyzeReceiptsInput = z.infer<typeof AnalyzeReceiptsSchema>;
