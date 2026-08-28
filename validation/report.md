# 検証レポート — 音質判定の推定誤差

`npm run validate` の出力。人間のラベル付けは使っていない。
注入した既知の物理量を推定器が復元できるかを測っている。

- 生成日時: 2026-08-28T04:04:05.684Z
- 素材: corpus:cmu-arctic-files-awb(3本)@16000Hz, corpus:cmu-arctic-files-awb(3本)@48000Hz, corpus:cmu-arctic-files-bdl(4本)@16000Hz, corpus:cmu-arctic-files-bdl(4本)@48000Hz, corpus:cmu-arctic-files-ksp(3本)@16000Hz, corpus:cmu-arctic-files-ksp(3本)@48000Hz, corpus:cmu-arctic-files-slt(3本)@16000Hz, corpus:cmu-arctic-files-slt(3本)@48000Hz, corpus:wideband(1本)@16000Hz, corpus:wideband(1本)@48000Hz
- 件数: 941
- MOSオラクル: 無効 (--mos が指定されていない)

## 1. 推定誤差

| 条件 | 推定対象 | 件数 | バイアス(平均誤差) | MAE | 最大誤差 | 最悪ケース |
|---|---|---:|---:|---:|---:|---|
| clip | クリップ率(有音基準) | 40 | 0 | 0 | 0 | s0-clip0_0002 (真値 0.0004 → 推定 0.0004) |
| cutoff | 帯域上限[Hz] | 33 | -6.061 | 6.061 | 100 | s2-lp4000 (真値 4000 → 推定 3900) |
| level | 有効音声レベル[dBFS] | 80 | 0 | 0 | 0 | s0-levelm70 (真値 -70 → 推定 -70) |
| pauses | SNR[dB] (間が少ない発話) | 40 | -4.077 | 4.668 | 8.147 | s2-pauses0_1 (真値 18.9871 → 推定 10.8404) |
| rt60 | RT60[秒] | 55 | -0.11 | 0.173 | 0.891 | s9-rt60-1_5 (真値 1.5 → 推定 0.6089) |
| rt60band | RT60[秒] (帯域依存) | 36 | 0.175 | 0.21 | 0.726 | s0-rt60band-ceiling (真値 0.4 → 推定 1.1261) |
| rt60rep | RT60[秒] (再現性) | 100 | -0.064 | 0.108 | 0.288 | s6-rt60rep-0_7-3 (真値 0.7 → 推定 0.4121) |
| snr | SNR[dB] | 160 | 0.304 | 1.595 | 5.375 | s2-snr20-white (真値 19.2794 → 推定 13.9045) |
| snrbabble | SNR[dB] (多人数の話し声) | 50 | 0.601 | 1.428 | 3.94 | s2-babble20 (真値 19.2794 → 推定 15.3391) |
| snrimpulse | SNR[dB] (衝撃性ノイズ) | 48 | 9.351 | 9.351 | 18.356 | s7-click8-15 (真値 14.7924 → 推定 33.148) |
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
| pauses / corpus:cmu-arctic-files-awb(3本)@16000Hz | 4 | 0.423 | 2.287 | 3.729 |
| pauses / corpus:cmu-arctic-files-awb(3本)@48000Hz | 4 | 0.094 | 1.526 | 2.626 |
| pauses / corpus:cmu-arctic-files-bdl(4本)@16000Hz | 4 | -7.652 | 7.652 | 8.147 |
| pauses / corpus:cmu-arctic-files-bdl(4本)@48000Hz | 4 | -7.273 | 7.273 | 7.81 |
| pauses / corpus:cmu-arctic-files-ksp(3本)@16000Hz | 4 | -4.829 | 5.521 | 8.14 |
| pauses / corpus:cmu-arctic-files-ksp(3本)@48000Hz | 4 | -4.785 | 5.671 | 7.967 |
| pauses / corpus:cmu-arctic-files-slt(3本)@16000Hz | 4 | -5.623 | 5.623 | 6.108 |
| pauses / corpus:cmu-arctic-files-slt(3本)@48000Hz | 4 | -4.903 | 4.903 | 5.444 |
| pauses / corpus:wideband(1本)@16000Hz | 4 | -3.125 | 3.125 | 3.451 |
| pauses / corpus:wideband(1本)@48000Hz | 4 | -3.094 | 3.094 | 3.616 |
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
| rt60band / corpus:cmu-arctic-files-awb(3本)@48000Hz | 4 | 0.278 | 0.278 | 0.608 |
| rt60band / corpus:cmu-arctic-files-bdl(4本)@16000Hz | 3 | 0.115 | 0.159 | 0.379 |
| rt60band / corpus:cmu-arctic-files-bdl(4本)@48000Hz | 3 | 0.157 | 0.243 | 0.485 |
| rt60band / corpus:cmu-arctic-files-ksp(3本)@16000Hz | 4 | 0.275 | 0.275 | 0.525 |
| rt60band / corpus:cmu-arctic-files-ksp(3本)@48000Hz | 4 | 0.253 | 0.253 | 0.497 |
| rt60band / corpus:cmu-arctic-files-slt(3本)@16000Hz | 4 | 0.122 | 0.183 | 0.583 |
| rt60band / corpus:cmu-arctic-files-slt(3本)@48000Hz | 4 | 0.147 | 0.186 | 0.302 |
| rt60band / corpus:wideband(1本)@16000Hz | 3 | 0.035 | 0.039 | 0.11 |
| rt60band / corpus:wideband(1本)@48000Hz | 3 | -0.062 | 0.087 | 0.216 |
| rt60rep / corpus:cmu-arctic-files-awb(3本)@16000Hz | 10 | 0.035 | 0.095 | 0.214 |
| rt60rep / corpus:cmu-arctic-files-awb(3本)@48000Hz | 10 | 0.076 | 0.076 | 0.199 |
| rt60rep / corpus:cmu-arctic-files-bdl(4本)@16000Hz | 10 | -0.136 | 0.136 | 0.263 |
| rt60rep / corpus:cmu-arctic-files-bdl(4本)@48000Hz | 10 | -0.127 | 0.127 | 0.258 |
| rt60rep / corpus:cmu-arctic-files-ksp(3本)@16000Hz | 10 | 0.004 | 0.067 | 0.233 |
| rt60rep / corpus:cmu-arctic-files-ksp(3本)@48000Hz | 10 | -0.021 | 0.092 | 0.213 |
| rt60rep / corpus:cmu-arctic-files-slt(3本)@16000Hz | 10 | -0.149 | 0.149 | 0.288 |
| rt60rep / corpus:cmu-arctic-files-slt(3本)@48000Hz | 10 | -0.055 | 0.067 | 0.145 |
| rt60rep / corpus:wideband(1本)@16000Hz | 10 | -0.139 | 0.139 | 0.271 |
| rt60rep / corpus:wideband(1本)@48000Hz | 10 | -0.128 | 0.128 | 0.243 |
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
| snrbabble / corpus:cmu-arctic-files-awb(3本)@16000Hz | 5 | 1.555 | 1.555 | 2.613 |
| snrbabble / corpus:cmu-arctic-files-awb(3本)@48000Hz | 5 | 1.899 | 1.899 | 2.566 |
| snrbabble / corpus:cmu-arctic-files-bdl(4本)@16000Hz | 5 | -0.773 | 1.864 | 3.94 |
| snrbabble / corpus:cmu-arctic-files-bdl(4本)@48000Hz | 5 | -0.065 | 1.931 | 2.432 |
| snrbabble / corpus:cmu-arctic-files-ksp(3本)@16000Hz | 5 | 0.262 | 0.908 | 1.703 |
| snrbabble / corpus:cmu-arctic-files-ksp(3本)@48000Hz | 5 | 0.282 | 1.236 | 2.21 |
| snrbabble / corpus:cmu-arctic-files-slt(3本)@16000Hz | 5 | 0.01 | 1.536 | 2.656 |
| snrbabble / corpus:cmu-arctic-files-slt(3本)@48000Hz | 5 | 0.452 | 0.889 | 1.676 |
| snrbabble / corpus:wideband(1本)@16000Hz | 5 | 0.901 | 0.98 | 2.509 |
| snrbabble / corpus:wideband(1本)@48000Hz | 5 | 1.483 | 1.483 | 2.679 |
| snrimpulse / corpus:cmu-arctic-files-awb(3本)@16000Hz | 5 | 9.423 | 9.423 | 15.266 |
| snrimpulse / corpus:cmu-arctic-files-awb(3本)@48000Hz | 3 | 7.501 | 7.501 | 9.473 |
| snrimpulse / corpus:cmu-arctic-files-bdl(4本)@16000Hz | 5 | 9.324 | 9.324 | 13.657 |
| snrimpulse / corpus:cmu-arctic-files-bdl(4本)@48000Hz | 4 | 6.886 | 6.886 | 9.256 |
| snrimpulse / corpus:cmu-arctic-files-ksp(3本)@16000Hz | 5 | 7.077 | 7.077 | 11.793 |
| snrimpulse / corpus:cmu-arctic-files-ksp(3本)@48000Hz | 4 | 7.399 | 7.399 | 9.41 |
| snrimpulse / corpus:cmu-arctic-files-slt(3本)@16000Hz | 5 | 10.833 | 10.833 | 14.594 |
| snrimpulse / corpus:cmu-arctic-files-slt(3本)@48000Hz | 5 | 13.362 | 13.362 | 18.356 |
| snrimpulse / corpus:wideband(1本)@16000Hz | 6 | 9.741 | 9.741 | 13.474 |
| snrimpulse / corpus:wideband(1本)@48000Hz | 6 | 10.113 | 10.113 | 15.231 |
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
| snrbabble | noise | + | 1 | 10 / 25点 | 想定どおり |
| snrimpulse | noise | + | -0.108 | 4 / 25点 | **まったく反応していない（測っていない）** |

## 3. 判定の不確かさの定数と実測の突き合わせ

判定は3値なので、境界の近くで断定しないための安全距離を軸ごとに持っている
（AudioAnalyzer の `AXIS_RATIO_UNCERTAINTY`）。その値は実測MAEから換算して
決めているので、**推定器を変えて定数を更新し忘れると黙って断定しすぎる**。
ここで機械的に突き合わせる。

| 軸 | 換算の元 | 実測MAE | 達成率に換算 | 定数 | 判定 |
|---|---|---:|---:|---:|---|
| reverb | 確定値のRT60 MAE (n=108) | 0.093 | 0.132 | 0.14 | 実測を覆っている |
| noise | SNR MAE（定常＋話し声, n=210） | 1.556 | 0.035 | 0.04 | 実測を覆っている |

## 6. マイク位置ごとの残響の測定能力

RT60を固定して直接音対残響比(DRR)だけを振った条件。DRRはマイク位置に相当し、
了解度にはRT60よりこちらが効く。近接マイクなら同じ部屋でも残響はほとんど乗らない。

目安: +15〜+25dB 近接(10〜30cm) / +5〜+15dB 卓上・ノートPC / -5〜+5dB 部屋の向こう

| DRR[dB] | 件数 | 測定できた | バイアス[秒] | MAE[秒] | 最大誤差[秒] | 減衰イベント数 | 参考値扱い |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 20 | 10 | 10 | -0.252 | 0.26 | 0.354 | 5.8 | 3 |
| 15 | 10 | 10 | -0.182 | 0.186 | 0.247 | 6.3 | 4 |
| 10 | 10 | 10 | -0.068 | 0.106 | 0.206 | 6.8 | 4 |
| 5 | 10 | 9 | 0.032 | 0.111 | 0.195 | 5.4 | 5 |
| 0 | 10 | 8 | 0.123 | 0.129 | 0.226 | 3.1 | 9 |
| -10 | 10 | 7 | 0.198 | 0.198 | 0.36 | 2.4 | 10 |

## 7. 帯域ごとにRT60が違う部屋での系統誤差

検証基盤の既定のインパルス応答は**スペクトルが平坦**な指数減衰で、全帯域が同じ
速さで減衰する。実室はそうならない——空気吸収と吸音材の効きが周波数で違うので、
高域ほど早く減衰する。広帯域のレベル列から測る推定器は**最も遅く減衰する帯域に
引っ張られる**ため、平坦な応答しか試していないとこの誤差は原理的に見えない。

真値は中帯域(500〜2000Hz)のRT60。ISO 3382 が代表値とする 500Hz/1kHz
オクターブの平均に対応する。`flat` が対照で、「平坦との差」がそのまま
周波数依存だけが持ち込む誤差になる。

| プロファイル | 低 / 中 / 高 [秒] | 件数 | 測定できた | バイアス[秒] | MAE[秒] | 最大誤差[秒] | 平坦との差[秒] | 確定値 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| flat | 0.5 / 0.5 / 0.5 | 10 | 10 | 0 | 0.074 | 0.183 | 0 | 9 |
| ceiling | 0.9 / 0.4 / 0.25 | 10 | 9 | 0.44 | 0.441 | 0.726 | 0.44 | 0 |
| meeting | 0.7 / 0.5 / 0.35 | 10 | 10 | 0.165 | 0.165 | 0.346 | 0.166 | 7 |
| hard | 1.2 / 0.9 / 0.6 | 10 | 7 | 0.101 | 0.171 | 0.302 | 0.102 | 0 |

## 8. 減衰の落差ごとのRT60誤差

ISO 3382 の T20 は減衰曲線の −5〜−25dB（20dB）を×3に外挿する。この実装は
−8〜−18dB（10dB）を**×6**に外挿しているので、曲率と雑音の影響が規格の手順より
2倍拡大される。「確定値」の条件は現在イベント数だけで、落差を見ていない。

落差が20dBに届いたイベントの数で層別する。**落差を条件に足すべきかは
この表が支持するかで決める**——誤差が下がるだけでは足りず、測れる件数も見る。

| T20相当のイベント数 | 件数 | 測定できた | バイアス[秒] | MAE[秒] | 最大誤差[秒] | 現在の確定値 |
|---|---:|---:|---:|---:|---:|---:|
| 0件 | 86 | 77 | -0.087 | 0.212 | 0.891 | 0 |
| 1件 | 67 | 67 | 0.003 | 0.115 | 0.583 | 61 |
| 2〜3件 | 38 | 38 | 0.006 | 0.093 | 0.36 | 38 |
| 4件以上 | 9 | 9 | 0.017 | 0.031 | 0.068 | 9 |

## 9. 間（無音区間）の量とSNRの測定能力

READMEは「話者の喋り方（声量のムラ、間の取り方）は評価しない。環境の評価では
ないため」と宣言している。SNRを固定して間だけを間引いた条件で、その宣言が
ノイズ軸について成り立っているかを見る。**誤差が動いたら、それは環境ではなく
喋り方への依存である。**

`無音フレーム` はノイズフロアの推定に使えたフレーム数。0 の行は下限を割って
パーセンタイル代替に落ちている。

| 残した無音 | 実際の無音率 | 件数 | バイアス[dB] | MAE[dB] | 最大誤差[dB] | 無音フレーム | 代替に落ちた |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 0.5 | 0.145 | 10 | -3.597 | 4.112 | 6.63 | 111.3 | 0 |
| 0.25 | 0.079 | 10 | -4.673 | 4.757 | 7.729 | 101.8 | 0 |
| 0.1 | 0.034 | 10 | -5.597 | 5.597 | 8.147 | 105 | 0 |
| 0.03 | 0.011 | 10 | -2.441 | 4.204 | 8.121 | 115.2 | 0 |

## 10. 衝撃性ノイズの検出

ノイズ軸は打鍵音のような衝撃音に無反応なので（節2の `snrimpulse` が `blind`）、
**スコアで表現できない事実を加工痕跡のフラグとして申告する**。スコアと判定は
動かさない。助言と同じく空振りは見落としより重い——正常な録音に
「打鍵音がある」と言うほうが道具への信頼を損なう。

陽性は `snrimpulse` 条件だけ。他のすべての条件が陰性で、そこに出たら空振りである。

| 出すべき | 出すべきでない | 的中 | 空振り | 見落とし | 適合率 | 再現率 |
|---:|---:|---:|---:|---:|---:|---:|
| 48 | 893 | 36 | 0 | 12 | 1 | 0.75 |

## 11. 判定の再現性（真値を固定して乱数だけ振る）

誤差表は「真値をずらしたときにどれだけ当たるか」を測る。しかしこの道具の出力は
3値の判定なので、利用者にとって意味があるのは**同じ部屋を測り直して同じ答えが
出るか**である。RT60とマイク位置を固定し、応答の実現（乱数）だけを振った条件。

**推定誤差が判定境界の間隔より広ければ、判定は測定ではなく抽選になる。**
残響軸は0.2秒で満点・0.9秒で0点の直線なので、RT60の誤差[秒]は 20/0.7 倍して
点数になる。判定の境界（達成率 0.55 と 0.35）の間隔は 0.20 しかない。

| 真のRT60[秒] | 件数 | 測定できた | 推定値の範囲[秒] | 残響軸 | good | usable | poor | 断定せず | 残響の助言 |
|---:|---:|---:|---|---|---:|---:|---:|---:|---:|
| 0.5 | 50 | 50 | 0.386 – 0.699 | 6–15 / 20 | 7 | 41 | 2 | 43 | 4 |
| 0.7 | 50 | 50 | 0.412 – 0.933 | 0–14 / 20 | 0 | 37 | 13 | 42 | 18 |

## 12. 判定の分離（複合条件）

判定は**最弱の軸**で決まるので、複数の軸が同時に下がる複合条件でこそ意味を持つ。
「良好」の群と「不可」の群でMOSの分布が重なっているなら、閾値は意味をなしていない。

| 判定 | 件数 | MOS平均 | MOS最小 | MOS最大 | うち参考値ありでgood不可 |
|---|---:|---:|---:|---:|---:|
| good | 0 | n/a | n/a | n/a | 0 |
| usable | 22 | n/a | n/a | n/a | 8 |
| poor | 158 | n/a | n/a | n/a | 5 |

## 13. 助言の的中と空振り

注入した物理量から「この助言が出るべきか」の真値が作れる。**空振りは見落としより重い**——
出すべき助言を落とすより、直さなくてよいものを直せと言うほうが道具への信頼を損なう。

| 助言 | 出すべき基準 | 出すべき | 出すべきでない | 的中 | 空振り | 見落とし | 適合率 | 再現率 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| bandwidth-narrow | 帯域上限 < 7000Hz | 30 | 3 | 30 | 0 | 0 | 1 | 1 |
| noise-high | SNR < 15dB（定常ノイズ） | 80 | 90 | 72 | 3 | 8 | 0.96 | 0.9 |
| noise-high | SNR < 15dB（非定常: 話し声・打鍵音） | 39 | 59 | 26 | 0 | 13 | 1 | 0.667 |
| reverb-strong | RT60 > 0.6秒 | 30 | 40 | 16 | 0 | 14 | 1 | 0.533 |
| clipping | クリップした標本が1つ以上 | 40 | 10 | 40 | 0 | 0 | 1 | 1 |
| muffled | 1kHz以上の傾斜 < -14dB/oct | 20 | 30 | 20 | 3 | 0 | 0.87 | 1 |
| level-low | 有効音声レベル < -30dBFS | 46 | 34 | 46 | 0 | 0 | 1 | 1 |

外れた行:

- noise-high 見落とし: s0-snr15-pink 真値 14.616
- noise-high 見落とし: s0-snr15-white 真値 14.616
- noise-high 見落とし: s1-snr15-pink 真値 14.612
- noise-high 見落とし: s0-babble15 真値 14.616
- noise-high 見落とし: s0-click8-15 真値 14.616
- noise-high 見落とし: s1-babble15 真値 14.612
- reverb-strong 見落とし: s1-rt60-1 真値 1
- reverb-strong 見落とし: s2-rt60-0_7 真値 0.7
- reverb-strong 見落とし: s2-rt60-1_5 真値 1.5
- muffled 空振り: s3-tiltm6 真値 -13.533
- muffled 空振り: s5-tiltm9 真値 -13.169
- muffled 空振り: s7-tiltm6 真値 -13.679

## 14. 劣化なし基準の挙動

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
