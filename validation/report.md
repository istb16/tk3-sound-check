# 検証レポート — 音質判定の推定誤差

`npm run validate` の出力。人間のラベル付けは使っていない。
注入した既知の物理量を推定器が復元できるかを測っている。

- 生成日時: 2026-08-24T06:43:36.932Z
- 素材: corpus:cmu-arctic-files-awb(3本)@16000Hz, corpus:cmu-arctic-files-awb(3本)@48000Hz, corpus:cmu-arctic-files-bdl(4本)@16000Hz, corpus:cmu-arctic-files-bdl(4本)@48000Hz, corpus:cmu-arctic-files-ksp(3本)@16000Hz, corpus:cmu-arctic-files-ksp(3本)@48000Hz, corpus:cmu-arctic-files-slt(3本)@16000Hz, corpus:cmu-arctic-files-slt(3本)@48000Hz
- 件数: 520
- MOSオラクル: 無効 (--mos が指定されていない)

## 1. 推定誤差

| 条件 | 推定対象 | 件数 | バイアス(平均誤差) | MAE | 最大誤差 | 最悪ケース |
|---|---|---:|---:|---:|---:|---|
| clip | クリップ率(有音基準) | 32 | 0 | 0 | 0 | s0-clip0_0002 (真値 0.0004 → 推定 0.0004) |
| cutoff | 帯域上限[Hz] | 24 | -8.333 | 8.333 | 100 | s2-lp4000 (真値 4000 → 推定 3900) |
| level | 有効音声レベル[dBFS] | 56 | 0 | 0 | 0 | s0-levelm45 (真値 -45 → 推定 -45) |
| rt60 | RT60[秒] | 40 | -0.001 | 0.096 | 0.474 | s0-rt60-1_5 (真値 1.5 → 推定 1.0257) |
| snr | SNR[dB] | 128 | -0.179 | 1.671 | 5.375 | s2-snr20-white (真値 19.2794 → 推定 13.9045) |
| tilt | 1kHz以上の傾斜[dB/oct] | 32 | -0.373 | 0.783 | 2.991 | s1-tiltm12 (真値 -22.4837 → 推定 -19.4922) |

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
| cutoff / corpus:cmu-arctic-files-awb(3本)@16000Hz | 3 | 0 | 0 | 0 |
| cutoff / corpus:cmu-arctic-files-awb(3本)@48000Hz | 3 | 0 | 0 | 0 |
| cutoff / corpus:cmu-arctic-files-bdl(4本)@16000Hz | 3 | -33.333 | 33.333 | 100 |
| cutoff / corpus:cmu-arctic-files-bdl(4本)@48000Hz | 3 | -33.333 | 33.333 | 100 |
| cutoff / corpus:cmu-arctic-files-ksp(3本)@16000Hz | 3 | 0 | 0 | 0 |
| cutoff / corpus:cmu-arctic-files-ksp(3本)@48000Hz | 3 | 0 | 0 | 0 |
| cutoff / corpus:cmu-arctic-files-slt(3本)@16000Hz | 3 | 0 | 0 | 0 |
| cutoff / corpus:cmu-arctic-files-slt(3本)@48000Hz | 3 | 0 | 0 | 0 |
| level / corpus:cmu-arctic-files-awb(3本)@16000Hz | 7 | 0 | 0 | 0 |
| level / corpus:cmu-arctic-files-awb(3本)@48000Hz | 7 | 0 | 0 | 0 |
| level / corpus:cmu-arctic-files-bdl(4本)@16000Hz | 7 | 0 | 0 | 0 |
| level / corpus:cmu-arctic-files-bdl(4本)@48000Hz | 7 | 0 | 0 | 0 |
| level / corpus:cmu-arctic-files-ksp(3本)@16000Hz | 7 | 0 | 0 | 0 |
| level / corpus:cmu-arctic-files-ksp(3本)@48000Hz | 7 | 0 | 0 | 0 |
| level / corpus:cmu-arctic-files-slt(3本)@16000Hz | 7 | 0 | 0 | 0 |
| level / corpus:cmu-arctic-files-slt(3本)@48000Hz | 7 | 0 | 0 | 0 |
| rt60 / corpus:cmu-arctic-files-awb(3本)@16000Hz | 6 | -0.015 | 0.168 | 0.474 |
| rt60 / corpus:cmu-arctic-files-awb(3本)@48000Hz | 5 | 0.033 | 0.144 | 0.404 |
| rt60 / corpus:cmu-arctic-files-bdl(4本)@16000Hz | 4 | -0.034 | 0.058 | 0.168 |
| rt60 / corpus:cmu-arctic-files-bdl(4本)@48000Hz | 4 | -0.054 | 0.122 | 0.269 |
| rt60 / corpus:cmu-arctic-files-ksp(3本)@16000Hz | 5 | 0.012 | 0.028 | 0.044 |
| rt60 / corpus:cmu-arctic-files-ksp(3本)@48000Hz | 6 | 0.041 | 0.066 | 0.266 |
| rt60 / corpus:cmu-arctic-files-slt(3本)@16000Hz | 5 | 0.02 | 0.102 | 0.256 |
| rt60 / corpus:cmu-arctic-files-slt(3本)@48000Hz | 5 | -0.033 | 0.066 | 0.198 |
| snr / corpus:cmu-arctic-files-awb(3本)@16000Hz | 16 | 0.912 | 1.797 | 3.539 |
| snr / corpus:cmu-arctic-files-awb(3本)@48000Hz | 16 | 1.42 | 1.745 | 3.315 |
| snr / corpus:cmu-arctic-files-bdl(4本)@16000Hz | 16 | -0.619 | 1.752 | 5.375 |
| snr / corpus:cmu-arctic-files-bdl(4本)@48000Hz | 16 | -0.252 | 2.033 | 5.042 |
| snr / corpus:cmu-arctic-files-ksp(3本)@16000Hz | 16 | -0.919 | 1.446 | 4.703 |
| snr / corpus:cmu-arctic-files-ksp(3本)@48000Hz | 16 | -1.195 | 1.624 | 4.424 |
| snr / corpus:cmu-arctic-files-slt(3本)@16000Hz | 16 | -0.512 | 0.958 | 3.557 |
| snr / corpus:cmu-arctic-files-slt(3本)@48000Hz | 16 | -0.267 | 2.014 | 4.4 |
| tilt / corpus:cmu-arctic-files-awb(3本)@16000Hz | 4 | 0.298 | 0.308 | 1.047 |
| tilt / corpus:cmu-arctic-files-awb(3本)@48000Hz | 4 | 0.988 | 0.988 | 2.991 |
| tilt / corpus:cmu-arctic-files-bdl(4本)@16000Hz | 4 | -0.273 | 0.273 | 0.709 |
| tilt / corpus:cmu-arctic-files-bdl(4本)@48000Hz | 4 | -0.658 | 0.658 | 1.756 |
| tilt / corpus:cmu-arctic-files-ksp(3本)@16000Hz | 4 | -0.9 | 0.9 | 1.759 |
| tilt / corpus:cmu-arctic-files-ksp(3本)@48000Hz | 4 | -1.178 | 1.178 | 2.882 |
| tilt / corpus:cmu-arctic-files-slt(3本)@16000Hz | 4 | -0.548 | 0.548 | 1.143 |
| tilt / corpus:cmu-arctic-files-slt(3本)@48000Hz | 4 | -0.717 | 1.413 | 1.745 |

### 未実装の推定器

- **drr** () — 48 件の検証データを生成済みだが、推定器が無いため誤差を測れない

## 2. スコアの単調性（Spearman順位相関）

劣化を強めたときスコアが正しい向きに動くか。符号が想定と逆なら、その軸は壊れている。

期待符号が `0 (無相関)` の行は「この条件に反応してはいけない」ことの監視。
反応していたら、別の要因をその軸で誤って減点している。

ρ は素材ごとに求めて平均している。全素材をまとめると、素材間の水準差だけで
相関が下がってしまうため。効果量（軸スコアが実際に動いた幅）も併記する——
順位相関はスケールフリーなので、無視できるズレと本質的な欠陥を区別できない。

| 条件 | 見る軸 | 期待符号 | ρ (素材平均) | 効果量 | 判定 |
|---|---|---:|---:|---:|---|
| snr | noise | + | 0.993 | 25 / 25点 | 想定どおり |
| clip | clip | - | -0.949 | 14 / 15点 | 想定どおり |
| cutoff | frequency | + | 1 | 9 / 25点 | 想定どおり |
| rt60 | reverb | - | -0.937 | 14.13 / 20点 | 想定どおり |
| rt60 | noise | 0 (無相関) | -0.633 | 0.75 / 25点 | 想定どおり |
| tilt | frequency | + | 0.987 | 8 / 25点 | 想定どおり |
| level | volume | + | 0.809 | 15 / 15点 | 想定どおり |
| drr | reverb | + | 0.88 | 13 / 20点 | 想定どおり |

## 5. 判定の分離（複合条件）

判定は**最弱の軸**で決まるので、複数の軸が同時に下がる複合条件でこそ意味を持つ。
「良好」の群と「不可」の群でMOSの分布が重なっているなら、閾値は意味をなしていない。

| 判定 | 件数 | MOS平均 | MOS最小 | MOS最大 | うち参考値ありでgood不可 |
|---|---:|---:|---:|---:|---:|
| good | 1 | n/a | n/a | n/a | 0 |
| usable | 9 | n/a | n/a | n/a | 3 |
| poor | 134 | n/a | n/a | n/a | 0 |

## 6. 劣化なし基準の挙動

| id | 総合 | ノイズ | 残響 | 周波数 | 音量 | 音割れ | 帯域上限[Hz] | 検出フラグ | 参考値扱いの軸 |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| s0-clean | 94 | 25 | 14 | 25 | 15 | 15 | 8000 | なし | なし |
| s1-clean | 94 | 25 | 14 | 25 | 15 | 15 | 7200 | band-limited | frequency, noise |
| s2-clean | 100 | 25 | 20 | 25 | 15 | 15 | 7500 | band-limited | frequency, noise |
| s3-clean | 100 | 25 | 20 | 25 | 15 | 15 | 7200 | band-limited | frequency, noise, reverb |
| s4-clean | 100 | 25 | 20 | 25 | 15 | 15 | 7400 | band-limited | frequency, noise, reverb |
| s5-clean | 100 | 25 | 20 | 25 | 15 | 15 | 7200 | band-limited | frequency, noise, reverb |
| s6-clean | 100 | 25 | 20 | 25 | 15 | 15 | 7300 | band-limited | frequency, noise, reverb |
| s7-clean | 100 | 25 | 20 | 25 | 15 | 15 | 7200 | band-limited | frequency, noise, reverb |
