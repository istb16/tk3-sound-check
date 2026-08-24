/**
 * 検証用のクリーン音声コーパスを取得する。
 *
 *   node validation/fetch-corpus.ts [--source=librispeech-dev-clean] [--limit=20] [--list]
 *
 * 音声ファイルは fixtures/corpus/ に置く。**ここは git 管理外**。
 * git に入るのは取得元の定義 (corpus-sources.json) と、生成した検証セットの
 * パラメータ記録 (manifest.json) だけ。
 *
 * 既定の取得元 (cmu-arctic-slt) は WAV 配布なので ffmpeg は不要。
 * FLAC 配布のコーパス (LibriSpeech 等) を使う場合だけ ffmpeg が必要になる。
 * どちらも使わない場合は、手持ちのクリーンなモノラルWAVを fixtures/corpus/ に
 * 直接置けばそのまま素材として使われる。何も置かなければ generate.ts が
 * 合成音声風信号で代替する。
 *
 * 1ファイルが2〜4秒の単発発話であることが多いので、generate.ts 側で
 * 目標長(既定10秒)に達するまで連結する。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { CORPUS_DIR, VALIDATION_DIR, numArg, parseArgs } from './lib/paths.ts';

interface SourceDef {
  /** 'archive' はアーカイブ一括、'files' は必要な本数だけ個別取得 */
  mode?: 'archive' | 'files';
  /** archive モード: アーカイブのURL */
  url?: string;
  archive?: string;
  innerGlob?: string;
  /** files モード: {n} を連番、{speaker} を話者IDに置き換えるURLテンプレート */
  urlTemplate?: string;
  indexFrom?: number;
  indexPad?: number;
  /** files モード: 話者ID。指定すると話者ごとに --limit 本ずつ取得する */
  speakers?: string[];
  audioFormat: string;
  requiresFfmpeg: boolean;
  /** archive モードは全体サイズ、files モードは1本あたりのサイズ[MB] */
  approxSizeMb: number;
  license: string;
  attribution: string;
  note?: string;
}

const args   = parseArgs(process.argv.slice(2));
const LIMIT  = numArg(args, 'limit', 20);
const config = JSON.parse(readFileSync(resolve(VALIDATION_DIR, 'corpus-sources.json'), 'utf8')) as {
  default: string;
  sources: Record<string, SourceDef>;
};
const SOURCE_KEY = typeof args.source === 'string' ? args.source : config.default;

/**
 * コマンドが使えるか。
 * バージョン確認のフラグはコマンドごとに違う（ffmpeg は -version、curl や tar は
 * --version）。両方試して、どちらかが成功すれば存在するとみなす。
 */
function has(cmd: string): boolean {
  for (const flag of ['--version', '-version']) {
    const r = spawnSync(cmd, [flag], { stdio: 'ignore' });
    if (r.status === 0) return true;
  }
  return false;
}

function listSources(): void {
  console.log('利用可能な取得元:\n');
  for (const [key, s] of Object.entries(config.sources)) {
    const mode = s.mode ?? 'archive';
    console.log(`  ${key}${key === config.default ? ' (既定)' : ''}`);
    console.log(`    URL       : ${s.url ?? s.urlTemplate}`);
    console.log(`    取得方法  : ${mode === 'files' ? '個別ファイル（--limit 本だけ）' : 'アーカイブ一括'}`);
    console.log(`    形式      : ${s.audioFormat}${s.requiresFfmpeg ? ' — ffmpeg が必要' : ''}`);
    console.log(
      mode === 'files'
        ? `    サイズ    : 1本あたり約 ${s.approxSizeMb} MB`
        : `    サイズ    : 約 ${s.approxSizeMb} MB`,
    );
    console.log(`    ライセンス: ${s.license}`);
    if (s.note) console.log(`    備考      : ${s.note}`);
    console.log('');
  }
  console.log('ffmpeg を使わない選択肢:');
  console.log(`  クリーンなモノラルWAVを ${CORPUS_DIR} に直接置く（そのまま素材になる）`);
  console.log('  何も置かなければ generate.ts が合成音声風信号で代替する');
}

/** ディレクトリを再帰的に走査して拡張子が一致するファイルを集める */
function walk(dir: string, ext: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, acc);
    else if (name.toLowerCase().endsWith(ext)) acc.push(p);
  }
  return acc;
}

/** 1ファイルあたりの再試行回数 */
const DOWNLOAD_ATTEMPTS = 3;
/** 連続でこの回数失敗したら、その話者を打ち切る */
const MAX_CONSECUTIVE_FAILURES = 3;

/** 1ファイル取得。一時的な失敗に備えて数回試す */
function tryDownload(url: string, out: string): boolean {
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      execFileSync('curl', ['-sS', '-L', '--fail', '--retry', '2', '-o', out, url]);
      return true;
    } catch {
      if (attempt === DOWNLOAD_ATTEMPTS) return false;
    }
  }
  return false;
}

/**
 * 個別ファイルを必要な本数だけ取得する。
 *
 * アーカイブ一括はサイズが大きい（CMU ARCTIC 全体で約115MB）。検証に必要なのは
 * 数十本なので、連番URLから必要なぶんだけ落とす。既に取得済みのものは飛ばす。
 */
function fetchIndividualFiles(src: SourceDef): void {
  const template = src.urlTemplate;
  if (!template) {
    console.error('files モードの取得元に urlTemplate がありません。');
    process.exit(1);
  }

  const from = src.indexFrom ?? 1;
  const pad  = src.indexPad ?? 4;
  const speakers = src.speakers ?? [''];
  const total = LIMIT * speakers.length;
  console.log(
    `個別取得: ${speakers.length}話者 × ${LIMIT}本 = ${total}本` +
    `（1本あたり約 ${src.approxSizeMb} MB, 合計約 ${(total * src.approxSizeMb).toFixed(1)} MB）`,
  );

  let fetched = 0;
  let skipped = 0;
  let consecutiveFailures = 0;
  for (const speaker of speakers) {
    for (let i = 0; i < LIMIT; i++) {
      const n = String(from + i).padStart(pad, '0');
      const url = template.replace('{n}', n).replace('{speaker}', speaker);
      // 素材名に話者を含める。generate.ts はこの接頭辞で素材をまとめる。
      const stem = speaker ? `${SOURCE_KEY}-${speaker}` : SOURCE_KEY;
      const out = join(CORPUS_DIR, `${stem}-${n}.wav`);

      if (existsSync(out) && statSync(out).size > 1000) { skipped++; continue; }

      if (tryDownload(url, out)) {
        fetched++;
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        console.warn(`\n  取得できませんでした: ${url}`);
        // 1本の失敗で打ち切ってはいけない。実際に一時的なネットワークエラーで
        // 話者1人ぶん(16本)を丸ごと取り逃していた。
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.warn(`  ${MAX_CONSECUTIVE_FAILURES}回連続で失敗したため、この話者を打ち切ります。`);
          break;
        }
        continue;
      }
      process.stdout.write(`\r取得 ${fetched + skipped}/${total}   `);
    }
    consecutiveFailures = 0;
  }
  process.stdout.write('\n');

  console.log(`\n完了: 新規${fetched}本 / 既存${skipped}本  → ${CORPUS_DIR} (git管理外)`);
  console.log(`ライセンス: ${src.license}`);
  console.log(`出典表記  : ${src.attribution}`);
  console.log('\n次: npm run generate');
}

function main(): void {
  if (args.list === true) { listSources(); return; }

  const src = config.sources[SOURCE_KEY];
  if (!src) {
    console.error(`未知の取得元: ${SOURCE_KEY}`);
    console.error('--list で一覧を表示できます。');
    process.exit(1);
  }

  if (src.requiresFfmpeg && !has('ffmpeg')) {
    console.error(`取得元 ${SOURCE_KEY} は ${src.audioFormat} 配布のため ffmpeg が必要です。`);
    console.error('');
    console.error('選択肢:');
    console.error('  1. ffmpeg を入れる (winget install Gyan.FFmpeg / brew install ffmpeg)');
    console.error(`  2. 手持ちのクリーンなモノラルWAVを ${CORPUS_DIR} に置く`);
    console.error('  3. 何も置かず npm run generate（合成音声風信号で代替される）');
    process.exit(1);
  }

  if (!has('curl')) {
    console.error('curl が見つかりません。手動でダウンロードしてください:');
    console.error(`  ${src.url ?? src.urlTemplate}`);
    process.exit(1);
  }

  mkdirSync(CORPUS_DIR, { recursive: true });

  if ((src.mode ?? 'archive') === 'files') {
    fetchIndividualFiles(src);
    return;
  }
  const work = resolve(CORPUS_DIR, '..', '_download');
  mkdirSync(work, { recursive: true });

  const archivePath = join(work, basename(new URL(src.url as string).pathname));
  if (existsSync(archivePath)) {
    console.log(`既にダウンロード済み: ${archivePath}`);
  } else {
    console.log(`ダウンロード中 (約 ${src.approxSizeMb} MB): ${src.url}`);
    execFileSync('curl', ['-L', '--fail', '--progress-bar', '-o', archivePath, src.url as string], { stdio: 'inherit' });
  }

  const extractDir = join(work, 'extracted');
  mkdirSync(extractDir, { recursive: true });
  console.log('展開中...');
  execFileSync('tar', ['-xf', archivePath, '-C', extractDir], { stdio: 'inherit' });

  const ext = `.${src.audioFormat.toLowerCase()}`;
  const found = walk(extractDir, ext).sort();
  if (found.length === 0) {
    console.error(`展開先に ${ext} が見つかりませんでした: ${extractDir}`);
    process.exit(1);
  }
  console.log(`${found.length} 件見つかりました。先頭 ${Math.min(LIMIT, found.length)} 件を変換します。`);

  const picked = found.slice(0, LIMIT);
  for (const [i, file] of picked.entries()) {
    const out = join(CORPUS_DIR, `${SOURCE_KEY}-${String(i).padStart(3, '0')}.wav`);
    if (ext === '.wav') {
      renameSync(file, out);
    } else {
      // モノラル・32bit float・元のサンプルレートを維持して変換する
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-ac', '1', '-c:a', 'pcm_f32le', out]);
    }
    process.stdout.write(`\r変換 ${i + 1}/${picked.length}   `);
  }
  process.stdout.write('\n');

  console.log(`\n完了: ${CORPUS_DIR} (git管理外)`);
  console.log(`ライセンス: ${src.license}`);
  console.log(`出典表記  : ${src.attribution}`);
  console.log(`\n作業ディレクトリ ${work} は不要になったら削除してよい。`);
  console.log('\n次: npm run generate');
}

main();
