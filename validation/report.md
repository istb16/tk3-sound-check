# 検証レポート — 音質判定の推定誤差

`npm run validate` の出力。人間のラベル付けは使っていない。
注入した既知の物理量を推定器が復元できるかを測っている。

- 生成日時: 2026-08-28T03:31:19.945Z
- 素材: corpus:cmu-arctic-files-awb(3本)@16000Hz, corpus:cmu-arctic-files-awb(3本)@48000Hz, corpus:cmu-arctic-files-bdl(4本)@16000Hz, corpus:cmu-arctic-files-bdl(4本)@48000Hz, corpus:cmu-arctic-files-ksp(3本)@16000Hz, corpus:cmu-arctic-files-ksp(3本)@48000Hz, corpus:cmu-arctic-files-slt(3本)@16000Hz, corpus:cmu-arctic-files-slt(3本)@48000Hz, corpus:wideband(1本)@16000Hz, corpus:wideband(1本)@48000Hz
- 件数: 903
- MOSオラクル: 無効 (--mos が指定されていない)

## 1. 推定誤差

| 条件 | 推定対象 | 件数 | バイアス(平均誤差) | MAE | 最大誤差 | 最悪ケース |
|---|---|---:|---:|---:|---:|---|
| clip | クリップ率(有音基準) | 40 | 0 | 0 | 0 | s0-clip0_0002 (真値 0.0004 → 推定 0.0004) |
| cutoff | 帯域上限[Hz] | 33 | -6.061 | 6.061 | 100 | s2-lp4000 (真値 4000 → 推定 3900) |
| level | 有効音声レベル[dBFS] | 80 | 0 | 0 | 0 | s0-levelm70 (真値 -70 → 推定 -70) |
| rt60 | RT60[秒] | 55 | -0.11 | 0.173 | 0.891 | s9-rt60-1_5 (真値 1.5 → 推定 0.6089) |
| rt60band | RT60[秒] (帯域依存) | 36 | 0.152 | 0.186 | 0.726 | s0-rt60band-ceiling (真値 0.4 → 推定 1.1261) |
| rt60rep | RT60[秒] (再現性) | 100 | -0.058 | 0.117 | 0.286 | s5-rt60rep-0_7-4 (真値 0.7 → 推定 0.9862) |
| snr | SNR[dB] | 160 | 0.304 | 1.595 | 5.375 | s2-snr20-white (真値 19.2794 → 推定 13.9045) |
| snrbabble | SNR[dB] (多人数の話し声) | 50 | 0.429 | 1.466 | 3.491 | s2-babble20 (真値 19.2794 → 推定 22.7706) |
| snrimpulse | SNR[dB] (衝撃性ノイズ) | 50 | 9.86 | 9.86 | 18.508 | s6-click8-15 (真値 14.8416 → 推定 33.3497) |
| tilt | 1kHz以上の傾斜[dB/oct] | 40 | -0.26 | 0.748 | 2.991 | s1-tiltm12 (真値 -22.4837 → 推定 -19.4922) |

### 素材ごとの内訳

推定器が特定の声質・発話速度に依存していないかを見る。
素材間でバイアスの符号が揃わない、あるいはMAEが大きく開く場合は、
その推定器が話者依存の仮定を持っている。

| 条件 / 素材 | 件数 | バイアス | MAE | 最大誤差 |
|---|---:|---:|---:|---:|
| clip / corpus:cmu-arctic-files-awb(3本)@16000Hz | 4 | 0 | 0 | 0 |
| clip / corpus:cmu-arctic-files-awb(3本)@48000Hz | 4 | 0 | 0 | 0 |
| clip / corpus:cmu-arctic-files-bdl(4本)@16000Hz | 4 | 0 | 0 | 0 |
| clip / corpus:cmu-arctic-files-bdl(4本)@48000Hz | 4 | 0 | 0 | 0 |
| clip / corpus:cmu-arctic-files-ksp(3本)@16000Hz | 4 | 0 | 0 | 0 |
| clip / corpus:cmu-arctic-files-ksp(3本)@48000Hz | 4 | 0 | 0 | 0 |
| clip / corpus:cmu-arctic-files-slt(3本)@16000Hz | 4 | 0 | 0 | 0 |
| clip / corpus:cmu-arctic-files-slt(3本)@48000Hz | 4 | 0 | 0 | 0 |
| clip / corpus:wideband(1本)@16000Hz | 4 | 0 | 0 | 0 |
| clip / corpus:wideband(1本)@48000Hz | 4 | 0 | 0 | 0 |
| cutoff / corpus:cmu-arctic-files-awb(3本)@16000Hz | 3 | 0 | 0 | 0 |
| cutoff / corpus:cmu-arctic-files-awb(3本)@48000Hz | 3 | 0 | 0 | 0 |
| cutoff / corpus:cmu-arctic-files-bdl(4本)@16000Hz | 3 | -33.333 | 33.333 | 100 |
| cutoff / corpus:cmu-arctic-files-bdl(4本)@48000Hz | 3 | -33.333 | 33.333 | 100 |
| cutoff / corpus:cmu-arctic-files-ksp(3本)@16000Hz | 3 | 0 | 0 | 0 |
| cutoff / corpus:cmu-arctic-files-ksp(3本)@48000Hz | 3 | 0 | 0 | 0 |
| cutoff / corpus:cmu-arctic-files-slt(3本)@16000Hz | 3 | 0 | 0 | 0 |
| cutoff / corpus:cmu-arctic-files-slt(3本)@48000Hz | 3 | 0 | 0 | 0 |
| cutoff / corpus:wideband(1本)@16000Hz | 3 | 0 | 0 | 0 |
| cutoff / corpus:wideband(1本)@48000Hz | 6 | 0 | 0 | 0 |
| level / corpus:cmu-arctic-files-awb(3本)@16000Hz | 8 | 0 | 0 | 0 |
| level / corpus:cmu-arctic-files-awb(3本)@48000Hz | 8 | 0 | 0 | 0 |
| level / corpus:cmu-arctic-files-bdl(4本)@16000Hz | 8 | 0 | 0 | 0 |
| level / corpus:cmu-arctic-files-bdl(4本)@48000Hz | 8 | 0 | 0 | 0 |
| level / corpus:cmu-arctic-files-ksp(3本)@16000Hz | 8 | 0 | 0 | 0 |
| level / corpus:cmu-arctic-files-ksp(3本)@48000Hz | 8 | 0 | 0 | 0 |
| level / corpus:cmu-arctic-files-slt(3本)@16000Hz | 8 | 0 | 0 | 0 |
| level / corpus:cmu-arctic-files-slt(3本)@48000Hz | 8 | 0 | 0 | 0 |
| level / corpus:wideband(1本)@16000Hz | 8 | 0 | 0 | 0 |
| level / corpus:wideband(1本)@48000Hz | 8 | 0 | 0 | 0 |
| rt60 / corpus:cmu-arctic-files-awb(3本)@16000Hz | 6 | 0.002 | 0.188 | 0.451 |
| rt60 / corpus:cmu-arctic-files-awb(3本)@48000Hz | 5 | 0.053 | 0.172 | 0.36 |
| rt60 / corpus:cmu-arctic-files-bdl(4本)@16000Hz | 5 | -0.095 | 0.112 | 0.316 |
| rt60 / corpus:cmu-arctic-files-bdl(4本)@48000Hz | 4 | -0.083 | 0.091 | 0.25 |
| rt60 / corpus:cmu-arctic-files-ksp(3本)@16000Hz | 6 | -0.137 | 0.145 | 0.515 |
| rt60 / corpus:cmu-arctic-files-ksp(3本)@48000Hz | 6 | -0.121 | 0.131 | 0.354 |
| rt60 / corpus:cmu-arctic-files-slt(3本)@16000Hz | 6 | -0.04 | 0.14 | 0.326 |
| rt60 / corpus:cmu-arctic-files-slt(3本)@48000Hz | 5 | -0.11 | 0.132 | 0.331 |
| rt60 / corpus:wideband(1本)@16000Hz | 6 | -0.275 | 0.297 | 0.866 |
| rt60 / corpus:wideband(1本)@48000Hz | 6 | -0.256 | 0.276 | 0.891 |
| rt60band / corpus:cmu-arctic-files-awb(3本)@16000Hz | 4 | 0.319 | 0.319 | 0.726 |
| rt60band / corpus:cmu-arctic-files-awb(3本)@48000Hz | 4 | 0.252 | 0.252 | 0.645 |
| rt60band / corpus:cmu-arctic-files-bdl(4本)@16000Hz | 2 | -0.03 | 0.03 | 0.055 |
| rt60band / corpus:cmu-arctic-files-bdl(4本)@48000Hz | 3 | 0.069 | 0.132 | 0.303 |
| rt60band / corpus:cmu-arctic-files-ksp(3本)@16000Hz | 4 | 0.286 | 0.286 | 0.534 |
| rt60band / corpus:cmu-arctic-files-ksp(3本)@48000Hz | 4 | 0.238 | 0.27 | 0.54 |
| rt60band / corpus:cmu-arctic-files-slt(3本)@16000Hz | 4 | -0.011 | 0.058 | 0.131 |
| rt60band / corpus:cmu-arctic-files-slt(3本)@48000Hz | 4 | 0.075 | 0.082 | 0.217 |
| rt60band / corpus:wideband(1本)@16000Hz | 4 | 0.11 | 0.157 | 0.368 |
| rt60band / corpus:wideband(1本)@48000Hz | 3 | 0.088 | 0.178 | 0.387 |
| rt60rep / corpus:cmu-arctic-files-awb(3本)@16000Hz | 10 | 0.088 | 0.088 | 0.168 |
| rt60rep / corpus:cmu-arctic-files-awb(3本)@48000Hz | 10 | 0.06 | 0.082 | 0.267 |
| rt60rep / corpus:cmu-arctic-files-bdl(4本)@16000Hz | 10 | -0.149 | 0.149 | 0.273 |
| rt60rep / corpus:cmu-arctic-files-bdl(4本)@48000Hz | 10 | -0.135 | 0.135 | 0.224 |
| rt60rep / corpus:cmu-arctic-files-ksp(3本)@16000Hz | 10 | -0.074 | 0.157 | 0.266 |
| rt60rep / corpus:cmu-arctic-files-ksp(3本)@48000Hz | 10 | 0.082 | 0.111 | 0.286 |
| rt60rep / corpus:cmu-arctic-files-slt(3本)@16000Hz | 10 | -0.102 | 0.102 | 0.179 |
| rt60rep / corpus:cmu-arctic-files-slt(3本)@48000Hz | 10 | -0.098 | 0.102 | 0.224 |
| rt60rep / corpus:wideband(1本)@16000Hz | 10 | -0.123 | 0.123 | 0.253 |
| rt60rep / corpus:wideband(1本)@48000Hz | 10 | -0.127 | 0.127 | 0.27 |
| snr / corpus:cmu-arctic-files-awb(3本)@16000Hz | 16 | 1.509 | 1.728 | 3.417 |
| snr / corpus:cmu-arctic-files-awb(3本)@48000Hz | 16 | 1.613 | 1.833 | 3.455 |
| snr / corpus:cmu-arctic-files-bdl(4本)@16000Hz | 16 | -0.63 | 1.74 | 5.375 |
| snr / corpus:cmu-arctic-files-bdl(4本)@48000Hz | 16 | -0.419 | 1.507 | 5.042 |
| snr / corpus:cmu-arctic-files-ksp(3本)@16000Hz | 16 | -0.808 | 1.506 | 4.703 |
| snr / corpus:cmu-arctic-files-ksp(3本)@48000Hz | 16 | -0.874 | 1.754 | 4.198 |
| snr / corpus:cmu-arctic-files-slt(3本)@16000Hz | 16 | -0.159 | 1.312 | 3.557 |
| snr / corpus:cmu-arctic-files-slt(3本)@48000Hz | 16 | 0.394 | 1.58 | 4.245 |
| snr / corpus:wideband(1本)@16000Hz | 16 | 1.17 | 1.52 | 3.961 |
| snr / corpus:wideband(1本)@48000Hz | 16 | 1.244 | 1.475 | 4.383 |
| snrbabble / corpus:cmu-arctic-files-awb(3本)@16000Hz | 5 | 0.886 | 1.124 | 2.281 |
| snrbabble / corpus:cmu-arctic-files-awb(3本)@48000Hz | 5 | 1.897 | 1.897 | 2.573 |
| snrbabble / corpus:cmu-arctic-files-bdl(4本)@16000Hz | 5 | 0.321 | 1.74 | 3.491 |
| snrbabble / corpus:cmu-arctic-files-bdl(4本)@48000Hz | 5 | -0.386 | 2.129 | 3.486 |
| snrbabble / corpus:cmu-arctic-files-ksp(3本)@16000Hz | 5 | -0.469 | 1.545 | 3.002 |
| snrbabble / corpus:cmu-arctic-files-ksp(3本)@48000Hz | 5 | -0.556 | 1.242 | 2.775 |
| snrbabble / corpus:cmu-arctic-files-slt(3本)@16000Hz | 5 | 0.625 | 1.339 | 2.424 |
| snrbabble / corpus:cmu-arctic-files-slt(3本)@48000Hz | 5 | -0.023 | 1.381 | 2.781 |
| snrbabble / corpus:wideband(1本)@16000Hz | 5 | 1.118 | 1.326 | 2.69 |
| snrbabble / corpus:wideband(1本)@48000Hz | 5 | 0.875 | 0.933 | 2.535 |
| snrimpulse / corpus:cmu-arctic-files-awb(3本)@16000Hz | 4 | 8.02 | 8.02 | 11.826 |
| snrimpulse / corpus:cmu-arctic-files-awb(3本)@48000Hz | 4 | 7.85 | 7.85 | 10.7 |
| snrimpulse / corpus:cmu-arctic-files-bdl(4本)@16000Hz | 5 | 8.898 | 8.898 | 13.869 |
| snrimpulse / corpus:cmu-arctic-files-bdl(4本)@48000Hz | 5 | 9.847 | 9.847 | 14.223 |
| snrimpulse / corpus:cmu-arctic-files-ksp(3本)@16000Hz | 5 | 8.092 | 8.092 | 12.564 |
| snrimpulse / corpus:cmu-arctic-files-ksp(3本)@48000Hz | 5 | 9.013 | 9.013 | 12.694 |
| snrimpulse / corpus:cmu-arctic-files-slt(3本)@16000Hz | 5 | 12.235 | 12.235 | 18.508 |
| snrimpulse / corpus:cmu-arctic-files-slt(3本)@48000Hz | 5 | 12.141 | 12.141 | 14.248 |
| snrimpulse / corpus:wideband(1本)@16000Hz | 6 | 10.83 | 10.83 | 14.158 |
| snrimpulse / corpus:wideband(1本)@48000Hz | 6 | 10.565 | 10.565 | 15.855 |
| tilt / corpus:cmu-arctic-files-awb(3本)@16000Hz | 4 | 0.298 | 0.308 | 1.047 |
| tilt / corpus:cmu-arctic-files-awb(3本)@48000Hz | 4 | 0.988 | 0.988 | 2.991 |
| tilt / corpus:cmu-arctic-files-bdl(4本)@16000Hz | 4 | -0.273 | 0.273 | 0.709 |
| tilt / corpus:cmu-arctic-files-bdl(4本)@48000Hz | 4 | -0.658 | 0.658 | 1.756 |
| tilt / corpus:cmu-arctic-files-ksp(3本)@16000Hz | 4 | -0.9 | 0.9 | 1.759 |
| tilt / corpus:cmu-arctic-files-ksp(3本)@48000Hz | 4 | -1.178 | 1.178 | 2.882 |
| tilt / corpus:cmu-arctic-files-slt(3本)@16000Hz | 4 | -0.548 | 0.548 | 1.143 |
| tilt / corpus:cmu-arctic-files-slt(3本)@48000Hz | 4 | -0.717 | 1.413 | 1.745 |
| tilt / corpus:wideband(1本)@16000Hz | 4 | 0.437 | 0.437 | 1.353 |
| tilt / corpus:wideband(1本)@48000Hz | 4 | -0.054 | 0.779 | 1.451 |

## 2. スコアの単調性（Spearman順位相関）

劣化を強めたときスコアが正しい向きに動くか。符号が想定と逆なら、その軸は壊れている。

期待符号が `0 (無相関)` の行は「この条件に反応してはいけない」ことの監視。
反応していたら、別の要因をその軸で誤って減点している。

ρ は素材ごとに求めて平均している。全素材をまとめると、素材間の水準差だけで
相関が下がってしまうため。効果量（軸スコアが実際に動いた幅）も併記する——
順位相関はスケールフリーなので、無視できるズレと本質的な欠陥を区別できない。

| 条件 | 見る軸 | 期待符号 | ρ (素材平均) | 効果量 | 判定 |
|---|---|---:|---:|---:|---|
| snr | noise | + | 0.998 | 18 / 25点 | 想定どおり |
| clip | clip | - | -0.949 | 14 / 15点 | 想定どおり |
| cutoff | frequency | + | 1 | 15 / 25点 | 想定どおり |
| rt60 | reverb | - | -0.955 | 13.4 / 20点 | 想定どおり |
| rt60 | noise | 0 (無相関) | -0.801 | 2.6 / 25点 | **反応してはいけない条件に反応している（別要因の誤計上）** |
| tilt | frequency | + | 0.979 | 19 / 25点 | 想定どおり |
| level | volume | + | 0.771 | 15 / 15点 | 想定どおり |
| drr | reverb | + | 0.881 | 19 / 20点 | 想定どおり |
| snrbabble | noise | + | 0.995 | 11 / 25点 | 想定どおり |
| snrimpulse | noise | + | 0.107 | 4 / 25点 | **まったく反応していない（測っていない）** |

## 5. マイク位置ごとの残響の測定能力

RT60を固定して直接音対残響比(DRR)だけを振った条件。DRRはマイク位置に相当し、
了解度にはRT60よりこちらが効く。近接マイクなら同じ部屋でも残響はほとんど乗らない。

目安: +15〜+25dB 近接(10〜30cm) / +5〜+15dB 卓上・ノートPC / -5〜+5dB 部屋の向こう

| DRR[dB] | 件数 | 測定できた | バイアス[秒] | MAE[秒] | 最大誤差[秒] | 減衰イベント数 | 参考値扱い |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 20 | 10 | 10 | -0.252 | 0.26 | 0.354 | 5.8 | 3 |
| 15 | 10 | 10 | -0.182 | 0.186 | 0.247 | 6.3 | 1 |
| 10 | 10 | 10 | -0.068 | 0.106 | 0.206 | 6.8 | 1 |
| 5 | 10 | 9 | 0.032 | 0.111 | 0.195 | 5.4 | 4 |
| 0 | 10 | 8 | 0.123 | 0.129 | 0.226 | 3.1 | 7 |
| -10 | 10 | 7 | 0.198 | 0.198 | 0.36 | 2.4 | 8 |

## 6. 帯域ごとにRT60が違う部屋での系統誤差

検証基盤の既定のインパルス応答は**スペクトルが平坦**な指数減衰で、全帯域が同じ
速さで減衰する。実室はそうならない——空気吸収と吸音材の効きが周波数で違うので、
高域ほど早く減衰する。広帯域のレベル列から測る推定器は**最も遅く減衰する帯域に
引っ張られる**ため、平坦な応答しか試していないとこの誤差は原理的に見えない。

真値は中帯域(500〜2000Hz)のRT60。ISO 3382 が代表値とする 500Hz/1kHz
オクターブの平均に対応する。`flat` が対照で、「平坦との差」がそのまま
周波数依存だけが持ち込む誤差になる。

| プロファイル | 低 / 中 / 高 [秒] | 件数 | 測定できた | バイアス[秒] | MAE[秒] | 最大誤差[秒] | 平坦との差[秒] | 確定値 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| flat | 0.5 / 0.5 / 0.5 | 10 | 10 | -0.045 | 0.07 | 0.134 | 0 | 10 |
| ceiling | 0.9 / 0.4 / 0.25 | 10 | 9 | 0.405 | 0.405 | 0.726 | 0.45 | 2 |
| meeting | 0.7 / 0.5 / 0.35 | 10 | 10 | 0.134 | 0.139 | 0.346 | 0.179 | 10 |
| hard | 1.2 / 0.9 / 0.6 | 10 | 7 | 0.136 | 0.136 | 0.235 | 0.182 | 0 |

## 7. 判定の再現性（真値を固定して乱数だけ振る）

誤差表は「真値をずらしたときにどれだけ当たるか」を測る。しかしこの道具の出力は
3値の判定なので、利用者にとって意味があるのは**同じ部屋を測り直して同じ答えが
出るか**である。RT60とマイク位置を固定し、応答の実現（乱数）だけを振った条件。

**推定誤差が判定境界の間隔より広ければ、判定は測定ではなく抽選になる。**
残響軸は0.2秒で満点・0.9秒で0点の直線なので、RT60の誤差[秒]は 20/0.7 倍して
点数になる。判定の境界（達成率 0.55 と 0.35）の間隔は 0.20 しかない。

| 真のRT60[秒] | 件数 | 測定できた | 推定値の範囲[秒] | 残響軸 | good | usable | poor | 断定せず | 残響の助言 |
|---:|---:|---:|---|---|---:|---:|---:|---:|---:|
| 0.5 | 50 | 50 | 0.298 – 0.767 | 4–17 / 20 | 35 | 13 | 2 | 1 | 8 |
| 0.7 | 50 | 50 | 0.427 – 0.986 | 0–14 / 20 | 19 | 16 | 15 | 2 | 22 |

## 8. 判定の分離（複合条件）

判定は**最弱の軸**で決まるので、複数の軸が同時に下がる複合条件でこそ意味を持つ。
「良好」の群と「不可」の群でMOSの分布が重なっているなら、閾値は意味をなしていない。

| 判定 | 件数 | MOS平均 | MOS最小 | MOS最大 | うち参考値ありでgood不可 |
|---|---:|---:|---:|---:|---:|
| good | 3 | n/a | n/a | n/a | 0 |
| usable | 19 | n/a | n/a | n/a | 0 |
| poor | 158 | n/a | n/a | n/a | 0 |

## 9. 助言の的中と空振り

注入した物理量から「この助言が出るべきか」の真値が作れる。**空振りは見落としより重い**——
出すべき助言を落とすより、直さなくてよいものを直せと言うほうが道具への信頼を損なう。

| 助言 | 出すべき基準 | 出すべき | 出すべきでない | 的中 | 空振り | 見落とし | 適合率 | 再現率 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| bandwidth-narrow | 帯域上限 < 7000Hz | 30 | 3 | 30 | 0 | 0 | 1 | 1 |
| noise-high | SNR < 15dB（定常ノイズ） | 80 | 90 | 72 | 3 | 8 | 0.96 | 0.9 |
| noise-high | SNR < 15dB（非定常: 話し声・打鍵音） | 40 | 60 | 27 | 0 | 13 | 1 | 0.675 |
| reverb-strong | RT60 > 0.6秒 | 30 | 40 | 16 | 0 | 14 | 1 | 0.533 |
| clipping | クリップした標本が1つ以上 | 40 | 10 | 40 | 0 | 0 | 1 | 1 |
| muffled | 1kHz以上の傾斜 < -14dB/oct | 20 | 30 | 20 | 3 | 0 | 0.87 | 1 |
| level-low | 有効音声レベル < -30dBFS | 46 | 34 | 46 | 0 | 0 | 1 | 1 |

外れた行:

- noise-high 見落とし: s0-snr15-pink 真値 14.616
- noise-high 見落とし: s0-snr15-white 真値 14.616
- noise-high 見落とし: s1-snr15-pink 真値 14.612
- noise-high 見落とし: s1-babble15 真値 14.612
- noise-high 見落とし: s2-click8-15 真値 14.754
- noise-high 見落とし: s3-click8-15 真値 14.771
- reverb-strong 見落とし: s1-rt60-1 真値 1
- reverb-strong 見落とし: s2-rt60-0_7 真値 0.7
- reverb-strong 見落とし: s2-rt60-1_5 真値 1.5
- muffled 空振り: s3-tiltm6 真値 -13.533
- muffled 空振り: s5-tiltm9 真値 -13.169
- muffled 空振り: s7-tiltm6 真値 -13.679

## 10. 劣化なし基準の挙動

| id | 総合 | ノイズ | 残響 | 周波数 | 音量 | 音割れ | 帯域上限[Hz] | 検出フラグ | 参考値扱いの軸 |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| s0-clean | 73 | 16 | 12 | 15 | 15 | 15 | 8000 | なし | なし |
| s1-clean | 72 | 16 | 12 | 14 | 15 | 15 | 7200 | band-limited | なし |
| s2-clean | 82 | 17 | 20 | 15 | 15 | 15 | 7500 | band-limited | なし |
| s3-clean | 83 | 18 | 20 | 15 | 15 | 15 | 7200 | band-limited | なし |
| s4-clean | 79 | 16 | 18 | 15 | 15 | 15 | 7400 | band-limited | reverb |
| s5-clean | 78 | 16 | 17 | 15 | 15 | 15 | 7200 | band-limited | reverb |
| s6-clean | 83 | 18 | 20 | 15 | 15 | 15 | 7300 | band-limited | reverb |
| s7-clean | 83 | 18 | 20 | 15 | 15 | 15 | 7200 | band-limited | reverb |
| s8-clean | 80 | 16 | 19 | 15 | 15 | 15 | 7200 | band-limited | なし |
| s9-clean | 90 | 16 | 19 | 25 | 15 | 15 | 24000 | なし | なし |
