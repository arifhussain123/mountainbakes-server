import 'dotenv/config';
import { auditBucket, configureBucket, desiredLifecycleRules, diffLifecycle, getBackupSystemConfig, getS3Client, isBackupError } from '../services/backup';

/**
 * Mountain Bakes — S3 bucket configuration for database backups.
 *
 * Usage (from backend/):
 *   pnpm backup:aws:audit                 read-only report: reachability, versioning, default encryption,
 *                                         Block Public Access, bucket policy, lifecycle rules vs the policy
 *   pnpm backup:aws:configure             prints what WOULD change (lifecycle diff, encryption, public access block)
 *   pnpm backup:aws:configure -- --confirm  applies it. Needs elevated one-off credentials
 *                                         (s3:PutLifecycleConfiguration, s3:PutEncryptionConfiguration,
 *                                         s3:PutBucketPublicAccessBlock) — NOT the server's backup user.
 *
 * Lifecycle rules are merged by rule ID: rules for other prefixes in the bucket
 * are preserved untouched. Idempotent — re-running applies nothing new.
 *
 * Exit codes: 0 audit clean / applied · 1 audit found problems or apply failed · 2 config invalid
 */

const argv = process.argv.slice(2);
const command = argv[0];
const confirm = argv.includes('--confirm');

async function main(): Promise<number> {
  const cfg = getBackupSystemConfig({ requireDatabase: false, requireEnabled: false });
  const s3 = getS3Client(cfg.region);
  console.log(`Mountain Bakes ERP — S3 backup bucket ${command === 'configure' ? 'configuration' : 'audit'}`);
  console.log('=========================================================');
  console.log(`Bucket: ${cfg.bucket}   Region: ${cfg.region}   Prefix: ${cfg.prefix}/\n`);

  const audit = await auditBucket(s3, cfg.bucket, cfg.prefix, cfg.retentionDays);
  for (const f of audit.findings) console.log(`${f.ok === true ? '✔' : f.ok === false ? '✖' : '?'} ${f.name.padEnd(22)} ${f.detail}`);

  if (command === 'audit' || !command) {
    const bad = audit.findings.filter((f) => f.ok === false);
    const unknown = audit.findings.filter((f) => f.ok !== true && f.ok !== false);
    if (bad.length > 0) {
      console.log(`\n${bad.length} finding(s) need attention — run \`pnpm backup:aws:configure -- --confirm\` with elevated credentials.`);
    } else if (unknown.length > 0) {
      // The backup key is object-scoped by design; bucket settings need an admin identity to read.
      console.log(`\nAudit incomplete: ${unknown.length} check(s) could not be read with these credentials — re-run with admin credentials or check them in the AWS console.`);
    } else {
      console.log('\nAudit clean.');
    }
    return bad.length === 0 && unknown.length === 0 ? 0 : 1;
  }

  if (command !== 'configure') {
    console.error('Usage: backup-aws <audit|configure> [--confirm]');
    return 2;
  }

  const desired = desiredLifecycleRules(cfg.prefix, cfg.retentionDays);
  const diff = diffLifecycle(audit.existingRules ?? [], desired);
  console.log('\nLifecycle rules (desired):');
  for (const r of desired) {
    const exp = r.Expiration?.Days ? `expire after ${r.Expiration.Days} days` : '';
    const tr = r.Transitions?.map((t) => `→ ${t.StorageClass} after ${t.Days} days`).join(', ') ?? '';
    const abort = r.AbortIncompleteMultipartUpload ? `abort incomplete multipart after ${r.AbortIncompleteMultipartUpload.DaysAfterInitiation} days` : '';
    const state = diff.missing.includes(r.ID!) ? 'MISSING' : diff.changed.includes(r.ID!) ? 'CHANGED' : 'ok';
    console.log(`  [${state.padEnd(7)}] ${r.ID}  ${r.Filter?.Prefix}  ${[tr, exp, abort].filter(Boolean).join('; ')}`);
  }
  if (diff.foreign.length > 0) console.log(`  (preserving ${diff.foreign.length} foreign rule(s): ${diff.foreign.join(', ')})`);

  const enc = audit.findings.find((f) => f.name === 'default encryption');
  const pab = audit.findings.find((f) => f.name === 'block public access');
  console.log(`\nDefault encryption:  ${enc?.ok ? 'already SSE-S3/KMS' : 'will set SSE-S3 (AES256)'}`);
  console.log(`Block public access: ${pab?.ok ? 'already on' : 'will enable all four settings'}`);
  if (audit.versioningEnabled) console.log('Versioning: ENABLED — NoncurrentVersionExpiration (1 day) is part of every rule so expired backups do not linger as old versions.');

  if (!confirm) {
    console.log('\nDry run — nothing applied. Re-run with `-- --confirm` to apply.');
    return 0;
  }
  const res = await configureBucket(s3, cfg.bucket, cfg.prefix, cfg.retentionDays, audit);
  console.log(`\nApplied: lifecycle ${res.lifecycle}, encryption ${res.encryption}, public access block ${res.publicAccessBlock}.`);
  const after = await auditBucket(s3, cfg.bucket, cfg.prefix, cfg.retentionDays);
  const bad = after.findings.filter((f) => f.ok === false);
  console.log(bad.length === 0 ? 'Post-apply audit clean.' : `Post-apply audit still reports: ${bad.map((b) => b.name).join(', ')}`);
  return bad.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (isBackupError(err) && err.category === 'CONFIG_INVALID') {
      console.error(`\n${err.message}`);
      process.exit(2);
    }
    console.error('\nbackup-aws failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
