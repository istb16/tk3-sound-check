import { beforeEach, describe, expect, it } from 'vitest';
import {
  REFERENCE_TTL_MS, clearStoredReference, loadReference, saveReference, touchReference,
} from './storage.ts';
import type { Reference } from './level.ts';

/**
 * 基準の保存。**取り違えの向きが非対称なので、迷ったら復元しない側に倒す。**
 *
 * 取り直しのコストは声10秒（壁時計で20〜30秒）、間違った基準のコストは間違った
 * フェーダー操作である。そして復元した基準が今も有効かは**原理的に検証できない**
 * （危ないのは3dBや6dBのずれで、それはこの道具が測るために存在している量そのもの）。
 */

const REF: Reference = {
  db: -32.5,
  zDb: -28.1,
  shape: [1, -2, 3, -1, 0, -1],
  unsettled: false,
};

const MIC = 'MacBook Pro のマイク';

beforeEach(() => {
  localStorage.clear();
});

describe('基準の保存 — 保存する／しない', () => {
  it('保存したものを同じマイク名で読み戻せる', () => {
    saveReference(REF, MIC, 1000);
    const got = loadReference(MIC, 1000 + 60_000);
    expect(got).not.toBeNull();
    expect(got!.reference).toEqual(REF);
    expect(got!.ageMs).toBe(60_000);
  });

  it('信用できない基準は保存しない', () => {
    // 画面で「この基準からの差は信用できません」と断っている値を、次のセッションで
    // 断りごと復元するか、断りを落として復元するかの二択はどちらも筋が悪い
    saveReference({ ...REF, unsettled: true }, MIC, 1000);
    expect(loadReference(MIC, 1000)).toBeNull();
  });

  it('マイク名が取れないときは保存しない', () => {
    // 復元してよいかを確かめる手立てが無くなる。中断からの再開で
    // 「同じ機材か確かめられないなら破棄する」としたのと向きを揃える
    saveReference(REF, '', 1000);
    expect(loadReference('', 1000)).toBeNull();
  });
});

describe('基準の保存 — 復元してよいかの判定', () => {
  it('別のマイクなら復元しない', () => {
    saveReference(REF, MIC, 1000);
    expect(loadReference('USB オーディオ', 1000)).toBeNull();
  });

  it('マイク名が取れなければ復元しない', () => {
    saveReference(REF, MIC, 1000);
    expect(loadReference('', 1000)).toBeNull();
  });

  it('期限内なら復元する', () => {
    saveReference(REF, MIC, 0);
    expect(loadReference(MIC, REFERENCE_TTL_MS - 1)).not.toBeNull();
  });

  it('期限を過ぎたら復元しない', () => {
    // 休憩を挟めば期限切れになるが、休憩中に会場は変わっているので取り直しが正しい
    saveReference(REF, MIC, 0);
    expect(loadReference(MIC, REFERENCE_TTL_MS + 1)).toBeNull();
  });

  it('使い続けている間は期限が延びる', () => {
    // 期限を「測り終えた時刻」から数えると、**測り続けているだけで切れる**——
    // 2時間の本番で最初に基準を取り、40分後にタブが落ちると、ずっと有効に
    // 使っていた基準が復元できない。この機能が防ごうとしている消え方そのもの
    saveReference(REF, MIC, 0);
    for (let t = 60_000; t <= 40 * 60_000; t += 60_000) touchReference(MIC, t);

    const got = loadReference(MIC, 40 * 60_000 + 1000);
    expect(got).not.toBeNull();
    // **画面に出す古さは延びない。** 利用者が知りたいのは「いつの会場の基準か」
    expect(got!.ageMs).toBe(40 * 60_000 + 1000);
  });

  it('別のマイクでは期限を延ばさない', () => {
    saveReference(REF, MIC, 0);
    touchReference('USB オーディオ', 5 * 60_000);
    expect(loadReference(MIC, REFERENCE_TTL_MS + 1)).toBeNull();
  });

  it('使うのをやめれば期限は切れる', () => {
    saveReference(REF, MIC, 0);
    touchReference(MIC, 60_000);
    expect(loadReference(MIC, 60_000 + REFERENCE_TTL_MS + 1)).toBeNull();
  });

  it('端末の時計が巻き戻っていたら復元しない', () => {
    saveReference(REF, MIC, 10_000);
    expect(loadReference(MIC, 5_000)).toBeNull();
  });
});

describe('基準の保存 — 消す', () => {
  it('消したら復元しない', () => {
    // `停止` と `基準を消す` から呼ぶ。**利用者が終わりを宣言した消え方**で
    // 生き残ると、捨てたはずの基準が10分以内の再訪で黙って復元される
    saveReference(REF, MIC, 1000);
    clearStoredReference();
    expect(loadReference(MIC, 1000)).toBeNull();
  });
});

describe('基準の保存 — 壊れた中身', () => {
  it('JSON でなければ復元しない', () => {
    localStorage.setItem('aqc-volume-reference', 'not json');
    expect(loadReference(MIC, 1000)).toBeNull();
  });

  it('形が足りなければ復元しない', () => {
    // 保存の形を変えた後に古い値が残っている場合。**読めたつもりで NaN を
    // 引き算する**のがいちばん悪い結末なので、読めないものは捨てる
    localStorage.setItem('aqc-volume-reference', JSON.stringify({
      reference: { db: -32.5, zDb: -28.1 }, deviceLabel: MIC, savedAt: 1000,
    }));
    expect(loadReference(MIC, 1000)).toBeNull();
  });

  it('数値でない基準は復元しない', () => {
    localStorage.setItem('aqc-volume-reference', JSON.stringify({
      reference: { db: null, zDb: -28.1, shape: [0, 0, 0, 0, 0, 0], unsettled: false },
      deviceLabel: MIC, capturedAt: 1000, lastUsedAt: 1000,
    }));
    expect(loadReference(MIC, 1000)).toBeNull();
  });

  it('バンド数の違う形は復元しない', () => {
    // `shapeDistanceDb` は短いほうに合わせて比べるので、これを通すと**少ない
    // バンドで比べた小さめの距離**が黙って出る。拍手や BGM を弾く仕組みが、
    // 気づかないうちに緩む
    localStorage.setItem('aqc-volume-reference', JSON.stringify({
      reference: { db: -32.5, zDb: -28.1, shape: [1, -2, 3], unsettled: false },
      deviceLabel: MIC, capturedAt: 1000, lastUsedAt: 1000,
    }));
    expect(loadReference(MIC, 1000)).toBeNull();
  });

  it('古い保存形式（時刻が1つしかない）は復元しない', () => {
    localStorage.setItem('aqc-volume-reference', JSON.stringify({
      reference: REF, deviceLabel: MIC, savedAt: 1000,
    }));
    expect(loadReference(MIC, 1000)).toBeNull();
  });
});
