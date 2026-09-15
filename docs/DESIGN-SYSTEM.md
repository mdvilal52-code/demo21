# Design System — "Emerald & Copper"

The UI/UX of every screen (admin dashboard and customer app) MUST match the reference design:
deep emerald green surfaces, brushed rose-gold/copper metallic cards, one cream/white card for
identity, thin geometric uppercase headings with wide tracking, rounded cards and pill controls.

Reference images live in `docs/design/reference/` (add `mobile-home.jpg` — the two-phone mockup).
Visual regression tests (Phase 7/8) compare rendered screens against these references.

## 1. Color tokens

| Token                  | Value                    | Use                                                                    |
| ---------------------- | ------------------------ | ---------------------------------------------------------------------- |
| `--emerald-950`        | `#04201A`                | page background bottom of gradient                                     |
| `--emerald-900`        | `#072B22`                | page background                                                        |
| `--emerald-800`        | `#0B3D30`                | primary surface                                                        |
| `--emerald-700`        | `#0F5240`                | raised surface / glass card base                                       |
| `--emerald-600`        | `#14684F`                | hover / gradient highlight                                             |
| `--emerald-glass`      | `rgba(20,104,79,0.55)`   | translucent card on emerald (with 1px `rgba(255,255,255,0.08)` border) |
| `--copper-900`         | `#6E4128`                | copper shadow edge                                                     |
| `--copper-700`         | `#9C6240`                | copper dark band                                                       |
| `--copper-500`         | `#C8865A`                | copper base / primary action                                           |
| `--copper-300`         | `#E2AE86`                | copper light band                                                      |
| `--copper-100`         | `#F1D2B6`                | copper specular highlight                                              |
| `--cream-50`           | `#FAF7F2`                | white card                                                             |
| `--cream-100`          | `#F1EAE0`                | white card border / dividers                                           |
| `--ink-900`            | `#14201B`                | text on copper and cream                                               |
| `--ink-600`            | `#3E4A45`                | secondary text on copper and cream                                     |
| `--on-emerald`         | `#EFE6D8`                | primary text on emerald                                                |
| `--on-emerald-muted`   | `rgba(239,230,216,0.68)` | secondary text on emerald                                              |
| `--accent-copper-text` | `#D9A878`                | copper-tinted headings on emerald                                      |
| `--success`            | `#5CC48F`                | verified / ok                                                          |
| `--warning`            | `#E3B25C`                | pending                                                                |
| `--danger`             | `#E06B6B`                | failed / escalated                                                     |

Gradients

```css
--bg-emerald: linear-gradient(180deg, #0f5240 0%, #0b3d30 45%, #04201a 100%);
--brushed-copper: linear-gradient(
  135deg,
  #6e4128 0%,
  #9c6240 18%,
  #c8865a 38%,
  #f1d2b6 50%,
  #c8865a 62%,
  #9c6240 82%,
  #6e4128 100%
);
/* brushed texture: overlay a repeating-linear-gradient of 1px alpha lines at 0.06 opacity */
--brushed-lines: repeating-linear-gradient(
  90deg,
  rgba(255, 255, 255, 0.06) 0 1px,
  transparent 1px 3px
);
```

Dark mode is the only mode for the customer app. The admin dashboard is emerald-dark by default
with an optional cream-light variant (same copper accents).

## 2. Typography

| Role                    | Font            | Style                                             |
| ----------------------- | --------------- | ------------------------------------------------- |
| Display / logo wordmark | `Jost` 300–400  | uppercase, `letter-spacing: 0.22em`               |
| Headings                | `Jost` 500      | uppercase, `letter-spacing: 0.14em`               |
| Body                    | `Inter` 400/500 | normal case, tabular numerals for money and dates |
| Micro labels            | `Inter` 500     | uppercase, 11px, `letter-spacing: 0.12em`         |

Sizes (mobile): display 26px, h1 20px, h2 16px, body 14px, micro 11px. Line-height 1.35.

## 3. Shape, elevation, motion

- Radii: card `22px`, small card / input `14px`, pill `999px`, monogram tile `16px`.
- Shadow (card on emerald): `0 14px 34px rgba(0,0,0,0.38)`.
- Copper cards get an inner highlight: `inset 0 1px 0 rgba(255,255,255,0.35)`.
- Motion: 180ms ease-out for hover/press, 320ms for card enter; never bounce.
- Touch targets ≥ 44px; safe-area insets respected (notch, home indicator).

## 4. Components (packages/ui)

| Component        | Description                                                                         |
| ---------------- | ----------------------------------------------------------------------------------- |
| `Monogram`       | copper outline geometric "N" mark, 44px, centered on brand screens                  |
| `Wordmark`       | "GLOBAL CONNECT" / product name in display style with a copper hairline underline   |
| `CopperCard`     | brushed-copper metallic card, ink text, optional icon slot + trailing action circle |
| `GlassCard`      | emerald translucent card with hairline border, on-emerald text                      |
| `CreamCard`      | white/cream card for identity and forms (Name / ID rows with copper chevrons)       |
| `PillButton`     | variants: `copper` (solid), `outline` (copper hairline on emerald), `ghost`         |
| `StatTile`       | KPI tile: micro label + large tabular number + trend; used in dashboard grid        |
| `JourneyStepper` | horizontal 19-step (collapsed to 5 milestones) stepper with copper dots             |
| `StatusChip`     | verified / pending / failed chips using success / warning / danger                  |
| `BottomTabBar`   | 3–5 icons, copper active state, glass background                                    |
| `TopBar`         | logo left, title center, profile right (dashboard)                                  |
| `ToggleSwitch`   | copper knob on emerald track                                                        |

All components are built on shadcn/ui primitives + Tailwind with the tokens above exposed as a
Tailwind preset in `packages/config/tailwind`.

## 5. Screen contracts

### Customer app — Home (Phase 8)

```
┌─────────────────────────┐
│        GOLD LOGO        │   Monogram + Wordmark
│     AI CONCIERGE        │
│ ┌─────────────────────┐ │
│ │ Upcoming Rental     │ │   CopperCard: vehicle, dates (15 → 19 Oct), city
│ │ Lamborghini Urus    │ │
│ │ 15 → 19 Oct · Dubai │ │
│ └─────────────────────┘ │
│ ┌─────────────────────┐ │
│ │ Documents            │ │  GlassCard: StatusChip per document
│ │ ✓ Passport           │ │
│ │ ✓ Driving License   │ │
│ └─────────────────────┘ │
│ ┌─────────────────────┐ │
│ │ Payment  AED 12,600  │ │  CopperCard: amount due / paid
│ └─────────────────────┘ │
│     [ CONTACT AI ]      │  PillButton copper
│  ◎      ▢      ◎        │  BottomTabBar
└─────────────────────────┘
```

### Admin dashboard — Home (Phase 7)

```
┌──────────────────────────────────────────────────────────┐
│  LOGO                 AI CONCIERGE              PROFILE  │  TopBar
├──────────────────────────────────────────────────────────┤
│  CUSTOMER JOURNEY                                        │
│  ● Enquiry ──● Dates ──● Vehicle ──● Quote ──● Booking  │  JourneyStepper (live counts per milestone)
├─────────────────────┬────────────────────────────────────┤
│ ACTIVE BOOKINGS  24 │ AI AUTOMATION  94.8% automated     │  StatTile ×4
├─────────────────────┼────────────────────────────────────┤
│ HUMAN ESCALATIONS 3 │ REVENUE  AED 000,000               │
└─────────────────────┴────────────────────────────────────┘
```

## 6. Accessibility

- Contrast: on-emerald text ≥ 4.5:1 against `--emerald-800`; ink on copper ≥ 4.5:1 against `--copper-300` band (test the lightest band).
- All icons have labels; stepper and chips expose state via `aria-*`.
- Reduced-motion respected.
