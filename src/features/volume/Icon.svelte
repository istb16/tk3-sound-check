<script lang="ts">
  /**
   * ボリュームチェックのアイコン。**この道具の画面の縮小図**である。
   *
   * 水平のレベルバーと、ピークホールドの縦マーカー。スピーカーや音量記号に
   * していないのは、この道具が「音量を出す」ものではなく「基準からの変化量を
   * 測る」ものだからで、縦マーカーがその基準にあたる。
   *
   * シルエットは横一文字。五角形（音質）とも棘のある山（ハウリング）とも
   * 遠いので、小さく表示しても取り違えない。角を丸めすぎると錠剤に見えるので
   * `rx` は控えめにしてある。
   */
</script>

<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <!-- バーの器。輪郭線を引くと「物体」に見えてバーに読めないので、薄い塗りにする -->
  <rect x="2" y="9.5" width="20" height="6" rx="2" fill="currentColor" fill-opacity="0.3" />
  <!-- いまのレベル -->
  <rect x="2" y="9.5" width="11" height="6" rx="2" fill="currentColor" />
  <!-- ピークホールド。この道具の主役は「どこまで動いたか」なので線を立てる -->
  <line x1="17.4" y1="4.8" x2="17.4" y2="20.2"
        stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
</svg>

<style>
  svg {
    inline-size: 100%;
    block-size: 100%;
    display: block;
  }
</style>
