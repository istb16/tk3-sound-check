<script lang="ts">
  import type { Lang } from '../../shell/i18n.ts';
  import ComingSoon from '../../pages/ComingSoon.svelte';
  import { T } from './i18n.ts';

  let { lang }: { lang: Lang } = $props();
  const t = $derived(T[lang]);
</script>

<ComingSoon {lang} summary={t.summary} note={t.note} />
