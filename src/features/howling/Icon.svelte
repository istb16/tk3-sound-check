<script lang="ts">
  /**
   * ハウリングチェックのアイコン。**この道具の画面の縮小図**である。
   *
   * 平らなスペクトルの中に1本だけ立つ細いピーク。これがこの道具の
   * 検出そのもの（周辺の中央値からどれだけ突出しているか）を絵にしたもので、
   * 突出度のバー表示ともそのまま対応する。
   *
   * 頂点に横線は引かない——引くと「T」の字に見え、スペクトルではなく
   * 記号として読まれる。
   *
   * **警告マーク（⚠）は使わない。** この道具は予兆を出さないと決めており、
   * 危険と断定もしない。⚠を掲げると「危険を知らせるアプリ」に見え、
   * 中身と食い違う。
   */
</script>

<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <!-- 周辺の床。ここに対してどれだけ持ち上がっているかが突出度 -->
  <g fill="currentColor" fill-opacity="0.45">
    <rect x="2.4"  y="16.5" width="2" height="4"   rx="1" />
    <rect x="5.8"  y="15"   width="2" height="5.5" rx="1" />
    <rect x="9.2"  y="16"   width="2" height="4.5" rx="1" />
    <rect x="15.8" y="15.5" width="2" height="5"   rx="1" />
    <rect x="19.2" y="17"   width="2" height="3.5" rx="1" />
  </g>
  <!-- 発振している1本だけが突き抜ける -->
  <rect x="12.5" y="3" width="2.2" height="17.5" rx="1.1" fill="currentColor" />
</svg>

<style>
  svg {
    inline-size: 100%;
    block-size: 100%;
    display: block;
  }
</style>
