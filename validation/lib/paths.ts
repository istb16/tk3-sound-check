import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const ROOT           = resolve(here, '..', '..');
export const VALIDATION_DIR = resolve(ROOT, 'validation');
export const CORPUS_DIR     = resolve(ROOT, 'fixtures', 'corpus');
export const GENERATED_DIR  = resolve(ROOT, 'fixtures', 'generated');
export const MODELS_DIR     = resolve(ROOT, 'fixtures', 'models');
export const MANIFEST       = resolve(VALIDATION_DIR, 'manifest.json');
export const REPORT_JSON    = resolve(VALIDATION_DIR, 'report.json');
export const REPORT_MD      = resolve(VALIDATION_DIR, 'report.md');

/** `--key=value` / `--flag` 形式の簡易パーサ */
export function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) out[a.slice(2)] = true;
    else out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}

export function numArg(args: Record<string, string | true>, key: string, fallback: number): number {
  const v = args[key];
  if (typeof v !== 'string') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
