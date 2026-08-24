import { describe, expect, it, beforeEach } from 'vitest';
import { initLang, T } from './i18n.ts';
import { ADVICE_CODES } from './AudioAnalyzer.ts';

describe('initLang', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('localStorage に ja がある場合は ja を返す', () => {
    localStorage.setItem('aqc-lang', 'ja');
    expect(initLang()).toBe('ja');
  });

  it('localStorage に en がある場合は en を返す', () => {
    localStorage.setItem('aqc-lang', 'en');
    expect(initLang()).toBe('en');
  });

  it('localStorage が空の場合はブラウザ言語にフォールバックする', () => {
    const result = initLang();
    expect(['ja', 'en']).toContain(result);
  });

  it('localStorage に無効な値がある場合は ja または en を返す', () => {
    localStorage.setItem('aqc-lang', 'fr');
    expect(['ja', 'en']).toContain(initLang());
  });
});

describe('T — 翻訳データの完整性', () => {
  it('ja と en が同じキーを持つ', () => {
    expect(Object.keys(T.ja)).toEqual(Object.keys(T.en));
  });

  it('categoryNames が両言語で volume/frequency/clip/noise を持つ', () => {
    const keys = ['volume', 'frequency', 'clip', 'noise'] as const;
    for (const k of keys) {
      expect(T.ja.categoryNames[k]).toBeTruthy();
      expect(T.en.categoryNames[k]).toBeTruthy();
    }
  });

  it('grades が両言語で good/ok/warn/bad を持つ', () => {
    const keys = ['good', 'ok', 'warn', 'bad'] as const;
    for (const k of keys) {
      expect(T.ja.grades[k]).toBeTruthy();
      expect(T.en.grades[k]).toBeTruthy();
    }
  });

  it('radarLabels が両言語で 5 要素を持つ', () => {
    expect(T.ja.radarLabels).toHaveLength(5);
    expect(T.en.radarLabels).toHaveLength(5);
  });

  it('判定文が両言語で3段階そろっている', () => {
    for (const k of ['good', 'usable', 'poor'] as const) {
      expect(T.ja.verdicts[k]).toBeTruthy();
      expect(T.en.verdicts[k]).toBeTruthy();
    }
  });

  it('測定不能時の判定文が「足を引っ張っている」とは別文になっている', () => {
    // 測定できなかった軸を「低スコアの軸」として提示すると誤解を招く
    for (const lang of [T.ja, T.en]) {
      expect(lang.verdictUnconfirmed('X')).not.toBe(lang.verdictLimitedBy('X'));
      expect(lang.verdictUnconfirmed('X').length).toBeGreaterThan(20);
    }
  });

  it('読み上げ文のサンプルが両言語にある', () => {
    expect(T.ja.micScript.length).toBeGreaterThan(0);
    expect(T.en.micScript.length).toBeGreaterThan(0);
    expect(T.ja.micHint).toBeTruthy();
    expect(T.en.micHint).toBeTruthy();
  });

  it('全アドバイスコードの文面が両言語にそろっている', () => {
    // 以前は分析側で日本語を組み立てていたため、ENモードでもアドバイスだけ
    // 日本語で表示されていた。コード化して両言語ぶんの網羅を強制する。
    for (const code of ADVICE_CODES) {
      for (const lang of [T.ja, T.en]) {
        const entry = lang.adviceTexts[code];
        expect(entry, code).toBeTruthy();
        const text = typeof entry === 'function' ? entry(5000) : entry;
        expect(text.length, code).toBeGreaterThan(10);
      }
    }
  });

  it('日本語と英語のアドバイス文面が別物である', () => {
    for (const code of ADVICE_CODES) {
      const ja = T.ja.adviceTexts[code];
      const en = T.en.adviceTexts[code];
      const jaText = typeof ja === 'function' ? ja(5000) : ja;
      const enText = typeof en === 'function' ? en(5000) : en;
      expect(jaText, code).not.toBe(enText);
      // 英語側に日本語が混ざっていないこと
      expect(/[ぁ-んァ-ヶ一-龠]/.test(enText), code).toBe(false);
    }
  });

  it('micBtn は秒数を受け取って文字列を返す', () => {
    expect(T.ja.micBtn(15)).toContain('15');
    expect(T.en.micBtn(15)).toContain('15');
  });
});

describe('加工痕跡の案内は対処を促さない', () => {
  // この道具が答えるのは「できあがった音声が会議の録音として使えるか」であって
  // 「部屋の音響がよいか」ではない。ノイズ抑制が入っていて結果の音声に問題が
  // なければ音質はよい。加工そのものを欠点として扱わないので、OSの設定を変えろ
  // といった対処を促す文面にはしない。
  //
  // 一度は「オーディオの拡張機能をオフに」と案内していた。実機で確認したところ
  // このツール自身のマイク録音にもOS側の処理がかかっており（getUserMedia の制約
  // では切れない）、その案内が必要な状況が既定の経路だと分かったが、方針として
  // 加工を欠点扱いしないことにしたため撤回した。
  for (const lang of [T.ja, T.en]) {
    it('OSの設定変更を促さない', () => {
      const text = [
        lang.provenanceIntro,
        lang.provenanceDigitalSilence,
        lang.provenanceZeroRun,
        lang.provenanceBandLimited(8000),
      ].join(' ').toLowerCase();
      for (const banned of ['オーディオの拡張機能', 'audio enhancements', 'サウンドの設定', 'sound settings']) {
        expect(text, banned).not.toContain(banned.toLowerCase());
      }
    });

    it('スコアが実際より高いとは言わない', () => {
      // スコアはこの音声そのものに対する評価なので、「実際より高く出る」は誤り。
      const text = [
        lang.provenanceIntro,
        lang.provenanceDigitalSilence,
        lang.provenanceZeroRun,
        lang.provenanceBandLimited(8000),
      ].join(' ');
      expect(text).not.toContain('実際より高く');
      expect(text.toLowerCase()).not.toContain('higher than it really');
    });
  }
});
