# Grill: Language toggle JA/EN
Date: 2026-07-09

## Intent
Add a JA/EN toggle button to the audio quality checker SPA. All Japanese UI text switches to English and vice versa. Preference persisted in localStorage, default from browser language.

## Key decisions
- Decision: h1 title ("音質チェッカー") also switches. Reason: keeping it Japanese in EN mode feels inconsistent. Alternative considered: leaving h1 as-is.
- Decision: RadarChart axis labels also switch (currently show raw English keys). Reason: the current state (radar=English, breakdown=Japanese) is an inconsistency; toggle is the opportunity to fix it.
- Decision: Toggle button is inside the header, inline with the title (option B). Reason: no persistent nav bar exists and the page doesn't scroll significantly, so `position:fixed` adds no value.
- Decision: Grade label translations: 優秀=Excellent, 良好=Good, 普通=Fair, 要改善=Poor.

## Surfaced assumptions
- The current UI is already hybrid (eyebrow/panel labels in English, functional text in Japanese). "English mode" means translating the Japanese functional text, not touching the already-English eyebrows.
- localStorage key: `aqc-lang`.
- Default: `navigator.language.startsWith('ja') ? 'ja' : 'en'`.

## Out of scope
- document.title switching (not discussed, not requested).
- Any backend or SSR consideration (browser-only SPA).
