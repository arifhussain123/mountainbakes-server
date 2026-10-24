import type { BackupType } from '../../shared';
import { karachiDateStr } from '../../shared';
import type { RetentionDays } from './backupConfig';

/**
 * Deterministic names. Every scheduled backup of a given type on a given
 * Karachi calendar date maps to exactly one backup_id and one S3 key, which is
 * what makes a re-run idempotent and duplicate detection possible:
 *
 *   daily    backup-daily-2026-09-21     <prefix>/daily/2026/09/mountainbakes-daily-2026-09-21.dump
 *   weekly   backup-weekly-2026-W38      <prefix>/weekly/2026/09/mountainbakes-weekly-2026-W38.dump
 *   monthly  backup-monthly-2026-08      <prefix>/monthly/2026/08/mountainbakes-monthly-2026-08.dump
 *   manual   backup-manual-2026-09-21T10-15-00Z  <prefix>/manual/2026/09/mountainbakes-manual-2026-09-21T10-15-00Z.dump
 *
 * Labels are computed on the Karachi calendar (the business timezone), not
 * UTC — a 03:00 PKT run is 22:00 UTC the previous day, and the backup should
 * be named for the day the business considers "today".
 *
 * Weekly = ISO week of the run date. The job runs Sunday, the last ISO day, so
 * W38 contains the whole of week 38. Monthly runs on the 1st and is labelled
 * for the month that just ENDED (a run on 2026-09-01 is monthly-2026-08),
 * because that is the month it contains in full.
 */

export const FILE_STEM = 'mountainbakes';

export interface BackupPlan {
  backupId: string;
  backupType: BackupType;
  label: string;
  /** 'YYYY/MM' folder segment. */
  folder: string;
  mainFileName: string;
  mainKey: string;
  manifestKey: string;
  /** Karachi date the run is attributed to. */
  runDate: string;
  retentionDays: number;
  retentionUntil: Date;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** ISO-8601 week + week-year for a 'YYYY-MM-DD' calendar date (pure UTC math, no local TZ). */
export function isoWeekOf(dateStr: string): { year: number; week: number } {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // Thursday of this ISO week
  const year = d.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return { year, week };
}

/** 'YYYY-MM' of the month before the one containing dateStr. */
export function previousMonthOf(dateStr: string): string {
  const [y, m] = dateStr.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 - 1, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

export function labelFor(type: BackupType, now: Date): string {
  const runDate = karachiDateStr(now);
  switch (type) {
    case 'daily':
      return runDate;
    case 'weekly': {
      const { year, week } = isoWeekOf(runDate);
      return `${year}-W${pad2(week)}`;
    }
    case 'monthly':
      return previousMonthOf(runDate);
    case 'manual':
      return now.toISOString().slice(0, 19).replace(/:/g, '-') + 'Z';
  }
}

export function backupIdFor(type: BackupType, now: Date): string {
  return `backup-${type}-${labelFor(type, now)}`;
}

function folderFor(type: BackupType, label: string, runDate: string): string {
  if (type === 'monthly') return label.replace('-', '/'); // 'YYYY-MM' → 'YYYY/MM'
  // daily / weekly / manual: the Karachi run month
  return `${runDate.slice(0, 4)}/${runDate.slice(5, 7)}`;
}

export function buildBackupPlan(
  type: BackupType,
  now: Date,
  cfg: { prefix: string; retentionDays: RetentionDays },
): BackupPlan {
  const runDate = karachiDateStr(now);
  const label = labelFor(type, now);
  const folder = folderFor(type, label, runDate);
  const backupId = `backup-${type}-${label}`;
  const mainFileName = `${FILE_STEM}-${type}-${label}.dump`;
  const retentionDays = cfg.retentionDays[type];
  return {
    backupId,
    backupType: type,
    label,
    folder,
    mainFileName,
    mainKey: `${cfg.prefix}/${type}/${folder}/${mainFileName}`,
    manifestKey: `${cfg.prefix}/manifests/${type}/${folder}/${backupId}.json`,
    runDate,
    retentionDays,
    retentionUntil: new Date(now.getTime() + retentionDays * 86_400_000),
  };
}

/**
 * Whether a scheduled type is due on the Karachi calendar right now, so
 * `backup:weekly` and `backup:monthly` can be run any day and decide for
 * themselves.
 */
export function isDue(type: BackupType, now: Date): { due: boolean; reason: string } {
  const runDate = karachiDateStr(now);
  switch (type) {
    case 'daily':
    case 'manual':
      return { due: true, reason: 'always due' };
    case 'weekly': {
      const dow = new Date(`${runDate}T00:00:00Z`).getUTCDay();
      return dow === 0
        ? { due: true, reason: `${runDate} is a Sunday in Asia/Karachi` }
        : { due: false, reason: `${runDate} is not a Sunday in Asia/Karachi (weekly backups run on Sunday)` };
    }
    case 'monthly': {
      const dom = Number(runDate.slice(8, 10));
      return dom === 1
        ? { due: true, reason: `${runDate} is the 1st of the month in Asia/Karachi` }
        : { due: false, reason: `${runDate} is not the 1st of the month in Asia/Karachi (monthly backups run on the 1st)` };
    }
  }
}

/** Parse the type and label back out of an S3 key under <prefix>/<type>/YYYY/MM/. */
export function parseBackupKey(prefix: string, key: string): { type: BackupType; label: string; role: 'main' | 'auth' } | null {
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/(daily|weekly|monthly|manual)/\\d{4}/\\d{2}/${FILE_STEM}-\\1-(.+?)(-auth)?\\.dump$`);
  const m = re.exec(key);
  if (!m) return null;
  return { type: m[1] as BackupType, label: m[2], role: m[3] ? 'auth' : 'main' };
}
