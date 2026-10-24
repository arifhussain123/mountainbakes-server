import {
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutPublicAccessBlockCommand,
  type LifecycleRule,
} from '@aws-sdk/client-s3';
import type { S3Like } from './s3BackupStorage';
import type { RetentionDays } from './backupConfig';

/**
 * Bucket-level configuration for the backup prefix: the lifecycle rules that
 * ARE the retention policy, default encryption, and Block Public Access.
 *
 * `auditBucket` is read-only and runs with the ordinary backup credentials
 * (it tolerates AccessDenied on each call and reports it). `configureBucket`
 * needs elevated, one-off credentials and is only ever run by a person with
 * `--confirm` — never from the server, never on a schedule.
 */

export const RULE_ID_PREFIX = 'mountainbakes-db-backups';

/**
 * Retention as S3 sees it. Expiration is evaluated once a day and applied at
 * the next UTC midnight after `Days` have elapsed since the object was
 * created, so an object can outlive its retention_until by up to ~24h.
 * Manifests are kept longer than the longest backup class so the record of a
 * backup outlives the backup itself.
 */
export function desiredLifecycleRules(prefix: string, retention: RetentionDays): LifecycleRule[] {
  const p = prefix.replace(/\/+$/, '');
  const mk = (id: string, sub: string, days: number, extra: Partial<LifecycleRule> = {}): LifecycleRule => ({
    ID: `${RULE_ID_PREFIX}-${id}`,
    Status: 'Enabled',
    Filter: { Prefix: `${p}/${sub}/` },
    Expiration: { Days: days },
    // Harmless when versioning is off; essential when it is on, otherwise a
    // "deleted" backup lives on as a noncurrent version.
    NoncurrentVersionExpiration: { NoncurrentDays: 1 },
    ...extra,
  });
  return [
    mk('daily', 'daily', retention.daily),
    mk('weekly', 'weekly', retention.weekly),
    mk('monthly', 'monthly', retention.monthly, { Transitions: [{ Days: 30, StorageClass: 'STANDARD_IA' }] }),
    mk('manual', 'manual', retention.manual),
    mk('manifests', 'manifests', Math.max(400, retention.monthly + 30)),
    {
      ID: `${RULE_ID_PREFIX}-abort-incomplete-multipart`,
      Status: 'Enabled',
      Filter: { Prefix: `${p}/` },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 },
    },
  ];
}

export interface AuditFinding {
  name: string;
  ok: boolean | null; // null = could not determine (no permission)
  detail: string;
}

export interface BucketAudit {
  bucket: string;
  findings: AuditFinding[];
  versioningEnabled: boolean | null;
  existingRules: LifecycleRule[] | null;
}

function denied(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'AccessDenied' || e?.$metadata?.httpStatusCode === 403;
}

export async function auditBucket(s3: S3Like, bucket: string, prefix: string, retention: RetentionDays): Promise<BucketAudit> {
  const findings: AuditFinding[] = [];
  let versioningEnabled: boolean | null = null;
  let existingRules: LifecycleRule[] | null = null;

  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    findings.push({ name: 'bucket reachable', ok: true, detail: bucket });
  } catch (err) {
    findings.push({ name: 'bucket reachable', ok: false, detail: String((err as Error).message) });
    return { bucket, findings, versioningEnabled, existingRules };
  }

  try {
    const v = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    versioningEnabled = v.Status === 'Enabled';
    findings.push({
      name: 'versioning',
      ok: true,
      detail: versioningEnabled
        ? 'ENABLED — lifecycle rules include NoncurrentVersionExpiration so deletes are real'
        : `${v.Status ?? 'Disabled'} — deletions remove the object immediately`,
    });
  } catch (err) {
    findings.push({ name: 'versioning', ok: null, detail: denied(err) ? 'no permission (s3:GetBucketVersioning)' : String((err as Error).message) });
  }

  try {
    const e = await s3.send(new GetBucketEncryptionCommand({ Bucket: bucket }));
    const rule = e.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault;
    const algo = rule?.SSEAlgorithm;
    findings.push({
      name: 'default encryption',
      ok: algo === 'AES256' || algo === 'aws:kms',
      detail: algo ? `${algo}${rule?.KMSMasterKeyID ? ' (KMS key configured)' : ''}` : 'none — every backup PutObject still sets AES256 explicitly',
    });
  } catch (err) {
    const e = err as { name?: string };
    if (e?.name === 'ServerSideEncryptionConfigurationNotFoundError') {
      findings.push({ name: 'default encryption', ok: false, detail: 'not configured — backup objects are still encrypted (AES256 set per upload); run aws:configure to set the bucket default' });
    } else {
      findings.push({ name: 'default encryption', ok: null, detail: denied(err) ? 'no permission (s3:GetEncryptionConfiguration)' : String((err as Error).message) });
    }
  }

  try {
    const p = await s3.send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
    const c = p.PublicAccessBlockConfiguration ?? {};
    const all = !!(c.BlockPublicAcls && c.IgnorePublicAcls && c.BlockPublicPolicy && c.RestrictPublicBuckets);
    findings.push({ name: 'block public access', ok: all, detail: all ? 'all four settings on' : JSON.stringify(c) });
  } catch (err) {
    const e = err as { name?: string };
    if (e?.name === 'NoSuchPublicAccessBlockConfiguration') findings.push({ name: 'block public access', ok: false, detail: 'not configured — run aws:configure' });
    else findings.push({ name: 'block public access', ok: null, detail: denied(err) ? 'no permission (s3:GetBucketPublicAccessBlock)' : String((err as Error).message) });
  }

  try {
    const pol = await s3.send(new GetBucketPolicyCommand({ Bucket: bucket }));
    const text: string = pol.Policy ?? '';
    const exposes = /"Principal"\s*:\s*"\*"/.test(text) && text.includes(prefix);
    findings.push({ name: 'bucket policy', ok: !exposes, detail: exposes ? `policy grants Principal "*" on something mentioning ${prefix} — REVIEW` : 'no public grant mentions the backup prefix' });
  } catch (err) {
    const e = err as { name?: string };
    if (e?.name === 'NoSuchBucketPolicy') findings.push({ name: 'bucket policy', ok: true, detail: 'no bucket policy (nothing public)' });
    else findings.push({ name: 'bucket policy', ok: null, detail: denied(err) ? 'no permission (s3:GetBucketPolicy)' : String((err as Error).message) });
  }

  try {
    const l = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
    existingRules = l.Rules ?? [];
    const diff = diffLifecycle(existingRules ?? [], desiredLifecycleRules(prefix, retention));
    findings.push({
      name: 'lifecycle rules',
      ok: diff.missing.length === 0 && diff.changed.length === 0,
      detail: diff.missing.length === 0 && diff.changed.length === 0 ? `all ${desiredLifecycleRules(prefix, retention).length} backup rules present` : `missing: [${diff.missing.join(', ')}] changed: [${diff.changed.join(', ')}]`,
    });
  } catch (err) {
    const e = err as { name?: string };
    if (e?.name === 'NoSuchLifecycleConfiguration') {
      existingRules = [];
      findings.push({ name: 'lifecycle rules', ok: false, detail: 'none configured — retention is NOT enforced until aws:configure is run' });
    } else {
      findings.push({ name: 'lifecycle rules', ok: null, detail: denied(err) ? 'no permission (s3:GetLifecycleConfiguration)' : String((err as Error).message) });
    }
  }

  return { bucket, findings, versioningEnabled, existingRules };
}

function normalizeRule(r: LifecycleRule): string {
  return JSON.stringify({
    Filter: r.Filter,
    Expiration: r.Expiration,
    Transitions: r.Transitions,
    NoncurrentVersionExpiration: r.NoncurrentVersionExpiration,
    AbortIncompleteMultipartUpload: r.AbortIncompleteMultipartUpload,
    Status: r.Status,
  });
}

/** Merge by rule ID: our rules are added/updated, every foreign rule is preserved untouched. */
export function diffLifecycle(existing: LifecycleRule[], desired: LifecycleRule[]): { merged: LifecycleRule[]; missing: string[]; changed: string[]; foreign: string[] } {
  const byId = new Map(existing.filter((r) => r.ID).map((r) => [r.ID!, r]));
  const missing: string[] = [];
  const changed: string[] = [];
  for (const d of desired) {
    const cur = byId.get(d.ID!);
    if (!cur) missing.push(d.ID!);
    else if (normalizeRule(cur) !== normalizeRule(d)) changed.push(d.ID!);
    byId.set(d.ID!, d);
  }
  const foreign = existing.filter((r) => r.ID && !r.ID.startsWith(RULE_ID_PREFIX)).map((r) => r.ID!);
  return { merged: [...byId.values()], missing, changed, foreign };
}

export interface ConfigureResult {
  lifecycle: 'applied' | 'unchanged';
  encryption: 'applied' | 'unchanged';
  publicAccessBlock: 'applied' | 'unchanged';
}

/** Idempotent. Requires s3:PutLifecycleConfiguration, s3:PutEncryptionConfiguration, s3:PutBucketPublicAccessBlock. */
export async function configureBucket(s3: S3Like, bucket: string, prefix: string, retention: RetentionDays, audit: BucketAudit): Promise<ConfigureResult> {
  const result: ConfigureResult = { lifecycle: 'unchanged', encryption: 'unchanged', publicAccessBlock: 'unchanged' };

  const diff = diffLifecycle(audit.existingRules ?? [], desiredLifecycleRules(prefix, retention));
  if (diff.missing.length > 0 || diff.changed.length > 0 || audit.existingRules === null) {
    await s3.send(new PutBucketLifecycleConfigurationCommand({ Bucket: bucket, LifecycleConfiguration: { Rules: diff.merged } }));
    result.lifecycle = 'applied';
  }

  const enc = audit.findings.find((f) => f.name === 'default encryption');
  if (!enc?.ok) {
    await s3.send(
      new PutBucketEncryptionCommand({
        Bucket: bucket,
        ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BucketKeyEnabled: false }] },
      }),
    );
    result.encryption = 'applied';
  }

  const pab = audit.findings.find((f) => f.name === 'block public access');
  if (!pab?.ok) {
    await s3.send(
      new PutPublicAccessBlockCommand({
        Bucket: bucket,
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
      }),
    );
    result.publicAccessBlock = 'applied';
  }
  return result;
}
