/**
 * MOSオラクル用のモデルを取得する（任意）。
 *
 *   node validation/fetch-mos-model.ts
 *
 * Microsoft DNS-Challenge が配布している DNSMOS (ITU-T P.835) のモデルを
 * fixtures/models/ に置く。**ここは git 管理外**、かつ**製品には載せない**。
 * 用途は開発時に「自分のスコアの並び順が、人間の主観評価で学習されたモデルの
 * 並び順とどれだけ一致しているか」を測ることだけ。
 *
 * ライセンスは配布元（microsoft/DNS-Challenge）の条件に従うこと。
 *
 * 推論には onnxruntime-node も必要:
 *   npm i -D onnxruntime-node
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { MODELS_DIR } from './lib/paths.ts';

/** P.835 の SIG/BAK/OVRL を返す主モデル */
const MODEL_URL =
  'https://raw.githubusercontent.com/microsoft/DNS-Challenge/master/DNSMOS/DNSMOS/sig_bak_ovr.onnx';
const MODEL_NAME = 'sig_bak_ovr.onnx';
/** 配布サイズ。これを大きく下回るならLFSポインタ等を掴んでいる */
const MIN_SIZE_BYTES = 1_000_000;

const ATTRIBUTION =
  'C. K. A. Reddy, V. Gopal, R. Cutler, "DNSMOS P.835: A non-matching reference ' +
  'based speech quality assessment for noise suppressors", ICASSP 2022 ' +
  '(microsoft/DNS-Challenge)';

function has(cmd: string): boolean {
  for (const flag of ['--version', '-version']) {
    if (spawnSync(cmd, [flag], { stdio: 'ignore' }).status === 0) return true;
  }
  return false;
}

function main(): void {
  if (!has('curl')) {
    console.error('curl が見つかりません。手動でダウンロードしてください:');
    console.error(`  ${MODEL_URL}`);
    console.error(`  → ${join(MODELS_DIR, MODEL_NAME)}`);
    process.exit(1);
  }

  mkdirSync(MODELS_DIR, { recursive: true });
  const dest = join(MODELS_DIR, MODEL_NAME);

  if (existsSync(dest) && statSync(dest).size >= MIN_SIZE_BYTES) {
    console.log(`既に取得済み: ${dest}`);
  } else {
    console.log(`ダウンロード中: ${MODEL_URL}`);
    execFileSync('curl', ['-L', '--fail', '--progress-bar', '-o', dest, MODEL_URL], { stdio: 'inherit' });
  }

  const size = statSync(dest).size;
  if (size < MIN_SIZE_BYTES) {
    console.error(`取得したファイルが小さすぎます (${size} bytes)。`);
    console.error('Git LFS のポインタや 404 ページを掴んでいる可能性があります。');
    process.exit(1);
  }

  console.log(`\n完了: ${dest} (${(size / 1024 / 1024).toFixed(2)} MB, git管理外)`);
  console.log(`出典表記: ${ATTRIBUTION}`);
  console.log('\nランタイムが未導入なら: npm i -D onnxruntime-node');
  console.log('次: npm run validate -- --mos');
}

main();
