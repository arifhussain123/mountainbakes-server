-- AI Expense Capture (owner's order, 2026-10-30).
--
-- Finance users photograph receipts; the server sends them to Google Gemini,
-- which proposes one expense per bill. The user edits each proposal and saves
-- it through the ordinary Income & Expense create, so an AI entry is a draft
-- like any other and reaches the ledger only when a finance approver approves
-- it. This migration adds only what that flow needs to be auditable:
--
--   finance_ai_captures            one row per analysis run: which photos,
--                                  which model, what it proposed (line items,
--                                  confidence, issues) or why it failed.
--   finance_transactions.ai_capture_id
--                                  the run an entry was generated from.
--   attachments.content_sha256     the stored bytes' fingerprint, so a receipt
--                                  already attached to an entry is recognised
--                                  when it is uploaded again.
--
-- Additive only: no existing row or rule changes.
-- ---------------------------------------------------------------------------

create table public.finance_ai_captures (
  id              uuid primary key default gen_random_uuid(),
  created_by      uuid not null references public.users (id) on delete restrict,
  created_by_name text,
  attachment_ids  uuid[] not null,
  model           text not null,
  status          text not null check (status in ('ok', 'failed')),
  result          jsonb,
  error           text,
  duration_ms     integer,
  created_at      timestamptz not null default now()
);
create index finance_ai_captures_created_by_idx on public.finance_ai_captures (created_by, created_at desc);

comment on table public.finance_ai_captures is
  'AI Expense Capture runs: the photos sent, the model, and what it proposed. Entries saved from a run point here through finance_transactions.ai_capture_id.';

alter table public.finance_transactions
  add column ai_capture_id uuid references public.finance_ai_captures (id) on delete restrict;
create index finance_txn_ai_capture_idx on public.finance_transactions (ai_capture_id) where ai_capture_id is not null;

comment on column public.finance_transactions.ai_capture_id is
  'The AI Expense Capture run this entry was generated from; null for an entry keyed by hand.';

alter table public.attachments add column content_sha256 text;
create index attachments_sha256_idx on public.attachments (content_sha256) where content_sha256 is not null;

comment on column public.attachments.content_sha256 is
  'sha256 of the stored bytes (hex), set on upload. Lets AI Expense Capture warn that a receipt is already attached to an entry.';
