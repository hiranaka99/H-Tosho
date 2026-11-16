---
"name": "H-Tosho"
"description": "The Sakura Library: warm, precise tools for library metadata and gallery discovery."
"colors":
  "background": "#fcf4f7"
  "sidebar": "#fff8fb"
  "surface": "#ffffff"
  "surface-2": "#f7e8ef"
  "border": "#eed9e3"
  "border-2": "#d9b8c8"
  "foreground": "#392333"
  "muted": "#795d70"
  "primary": "#aa386a"
  "primary-hover": "#902a57"
  "primary-button": "#aa386a"
  "primary-button-hover": "#902a57"
  "success": "#0b7d66"
  "warning": "#aa6b15"
  "danger": "#b8364c"
  "info": "#79518f"
  "skeleton-base": "#f7e8ef"
  "skeleton-hi": "#eed9e3"
  "dark-background": "#160f18"
  "dark-sidebar": "#1d1420"
  "dark-surface": "#251a29"
  "dark-surface-2": "#322335"
  "dark-border": "#453047"
  "dark-border-2": "#634760"
  "dark-foreground": "#faeaf2"
  "dark-muted": "#c4a6ba"
  "dark-primary": "#f39cbd"
  "dark-primary-hover": "#ffc0d7"
  "dark-primary-button": "#b33b70"
  "dark-primary-button-hover": "#c0457d"
  "dark-success": "#38cba6"
  "dark-warning": "#e5b454"
  "dark-danger": "#f07d8a"
  "dark-info": "#d3adeb"
  "dark-skeleton-base": "#322335"
  "dark-skeleton-hi": "#48324b"
  "white": "#fff"
  "provider-anilist": "#02b968"
  "provider-mangadex": "#f4c145"
  "provider-myanimelist": "#3b82f6"
"typography":
  "headline":
    "fontFamily": "\"Inter\", \"Segoe UI\", system-ui, -apple-system, sans-serif"
    "fontSize": "1.5rem"
    "lineHeight": "2rem"
    "fontWeight": 600
    "letterSpacing": "-0.025em"
  "title":
    "fontFamily": "\"Inter\", \"Segoe UI\", system-ui, -apple-system, sans-serif"
    "fontSize": "0.875rem"
    "lineHeight": "1.25rem"
    "fontWeight": 600
    "letterSpacing": "-0.025em"
  "dialog-title":
    "fontFamily": "\"Inter\", \"Segoe UI\", system-ui, -apple-system, sans-serif"
    "fontSize": "1rem"
    "lineHeight": "1.5rem"
    "fontWeight": 600
    "letterSpacing": "-0.025em"
  "body":
    "fontFamily": "\"Inter\", \"Segoe UI\", system-ui, -apple-system, sans-serif"
    "fontSize": "0.875rem"
    "lineHeight": "1.25rem"
    "fontWeight": 400
  "label":
    "fontFamily": "\"Inter\", \"Segoe UI\", system-ui, -apple-system, sans-serif"
    "fontSize": "0.75rem"
    "lineHeight": "1rem"
    "fontWeight": 500
  "micro-label":
    "fontFamily": "\"Inter\", \"Segoe UI\", system-ui, -apple-system, sans-serif"
    "fontSize": "0.625rem"
    "lineHeight": "0.875rem"
    "fontWeight": 500
  "button":
    "fontFamily": "\"Inter\", \"Segoe UI\", system-ui, -apple-system, sans-serif"
    "fontSize": "0.875rem"
    "lineHeight": 1.25
    "fontWeight": 500
  "metric":
    "fontFamily": "\"Inter\", \"Segoe UI\", system-ui, -apple-system, sans-serif"
    "fontSize": "1.875rem"
    "lineHeight": "2.25rem"
    "fontWeight": 600
  "mono":
    "fontFamily": "\"JetBrains Mono\", \"Cascadia Code\", ui-monospace, monospace"
    "fontSize": "0.75rem"
    "lineHeight": "1rem"
    "fontWeight": 400
"rounded":
  "sm": "0.25rem"
  "md": "0.375rem"
  "lg": "0.5rem"
  "xl": "0.75rem"
  "2xl": "1rem"
"spacing":
  "1": "0.25rem"
  "2": "0.5rem"
  "3": "0.75rem"
  "4": "1rem"
  "5": "1.25rem"
  "8": "2rem"
  "0.5": "0.125rem"
  "1.5": "0.375rem"
  "2.5": "0.625rem"
"components":
  "button-primary":
    "backgroundColor": "{colors.primary-button}"
    "textColor": "{colors.white}"
    "typography": "{typography.button}"
    "rounded": "{rounded.lg}"
    "padding": "0 0.75rem"
    "height": "2.25rem"
  "button-primary-hover":
    "backgroundColor": "{colors.primary-button-hover}"
    "textColor": "{colors.white}"
  "button-outline":
    "backgroundColor": "{colors.surface}"
    "textColor": "{colors.foreground}"
    "typography": "{typography.button}"
    "rounded": "{rounded.lg}"
    "padding": "0 0.75rem"
    "height": "2.25rem"
  "button-outline-hover":
    "backgroundColor": "{colors.surface-2}"
    "textColor": "{colors.foreground}"
  "button-ghost":
    "backgroundColor": "transparent"
    "textColor": "{colors.muted}"
    "typography": "{typography.button}"
    "rounded": "{rounded.lg}"
    "padding": "0 0.75rem"
    "height": "2.25rem"
  "button-ghost-hover":
    "backgroundColor": "{colors.surface-2}"
    "textColor": "{colors.foreground}"
  "button-danger":
    "backgroundColor": "{colors.danger}"
    "textColor": "{colors.white}"
    "typography": "{typography.button}"
    "rounded": "{rounded.lg}"
    "padding": "0 0.75rem"
    "height": "2.25rem"
  "button-danger-hover":
    "backgroundColor": "{colors.danger}"
    "textColor": "{colors.white}"
  "button-secondary":
    "backgroundColor": "{colors.surface-2}"
    "textColor": "{colors.foreground}"
    "typography": "{typography.button}"
    "rounded": "{rounded.lg}"
    "padding": "0 0.75rem"
    "height": "2.25rem"
  "button-secondary-hover":
    "backgroundColor": "color-mix(in oklab, #eed9e3 60%, transparent)"
    "textColor": "{colors.foreground}"
  "button-primary-dark":
    "backgroundColor": "{colors.dark-primary-button}"
    "textColor": "{colors.white}"
  "button-primary-dark-hover":
    "backgroundColor": "{colors.dark-primary-button-hover}"
  "button-danger-dark":
    "backgroundColor": "{colors.dark-danger}"
    "textColor": "{colors.dark-background}"
  "input":
    "backgroundColor": "{colors.surface-2}"
    "textColor": "{colors.foreground}"
    "typography": "{typography.body}"
    "rounded": "{rounded.lg}"
    "padding": "0 0.75rem"
    "height": "2.25rem"
  "input-focus":
    "backgroundColor": "{colors.surface}"
  "card":
    "backgroundColor": "{colors.surface}"
    "textColor": "{colors.foreground}"
    "rounded": "{rounded.xl}"
  "badge-default":
    "backgroundColor": "{colors.surface-2}"
    "textColor": "{colors.foreground}"
    "typography": "{typography.label}"
    "padding": "0.125rem 0.5rem"
  "navigation-active":
    "backgroundColor": "color-mix(in oklab, #aa386a 10%, transparent)"
    "textColor": "{colors.primary}"
    "rounded": "{rounded.lg}"
    "height": "2.25rem"
    "padding": "0 2.75rem 0 0.75rem"
  "tab-active":
    "textColor": "{colors.primary}"
    "typography": "{typography.label}"
---

# Design System: H-Tosho

## Overview

**Creative North Star: "The Sakura Library"**

The Sakura Library is warm and precise: a compact, task-focused interface with gentle expression. Sakura Rose accents and Blush Paper surfaces surround Plum Ink text. The light theme feels like a softly tinted catalogue; the dark theme carries the same identity through moonlit plum surfaces and pale pink highlights.

Controls are softly rounded, precise, and quietly tactile. Tonal layers organize dense work, subtle structural shadows separate surfaces, and a small hover lift gives eligible controls feedback. Cover artwork supplies the strongest imagery; the surrounding interface keeps titles, metadata, states, and actions readable.

This file records the implemented frontend, with descriptive language confirmed by the owner. Sources are [semantic tokens and interaction styles](src/index.css), [shared components](src/components/ui.tsx), [application shell](src/App.tsx), and [page implementations](src/pages/). The [desktop](../docs/screenshots/libraries.png), [mobile](../docs/screenshots/libraries-mobile.png), and [dark metadata preview](../docs/screenshots/metadata-preview.png) corroborate the palette, hierarchy, and density. They are sample-data captures, not a fresh live-browser validation; current code takes precedence where details differ.

The document follows the [DESIGN.md format](https://raw.githubusercontent.com/google-labs-code/design.md/main/docs/spec.md). Its companion [.impeccable/design.json](.impeccable/design.json) holds shadows, motion, breakpoints, narrative, and ten standalone component specimens. Generated tonal ramps are preview metadata, not additional app tokens; the specimens illustrate styles without replacing the React components' interaction behavior.

**Key Characteristics:**
- Sakura Rose accents, Blush Paper surfaces, and Plum Ink neutrals.
- Compact Inter typography with JetBrains Mono for technical output.
- Tonal layering, fine borders, and subtle structural shadows.
- Softly rounded controls with brief, local interaction feedback.
- Light, dark, and system themes; desktop and touch layouts.

## Colors

The palette combines Sakura Rose actions, Blush Paper surfaces, and Plum Ink text with distinct semantic status colors.

The frontmatter preserves the source token names. Unprefixed semantic colors describe light mode; `dark-*` entries record the matching dark-mode overrides. These are documentation names: app code continues to use the same theme-aware CSS variable in both modes. White and provider colors are shared constants. Opacity treatments are composed from these colors rather than separate palettes.

### Primary

- **Sakura Rose** (`primary`, `primary-hover`): links, selected text, tab indicators, progress fills, and translucent active backgrounds. Dark mode uses a pale rose for the same roles.
- **Filled Sakura Rose** (`primary-button`, `primary-button-hover`): filled action buttons and selected switches. It matches primary in light mode but remains a deeper rose in dark mode so white labels retain their intended treatment.

**The The Two Pink Roles Rule.** Use the semantic primary token for text, indicators, and translucent highlights; use primary-button for filled actions with white text. Preserve their separate dark-theme values.

### Neutral

- **Blush Paper** (`background`): the page canvas; **Sidebar Paper** (`sidebar`): the navigation shell.
- **Card Paper** (`surface`): cards, dialogs, and active field surfaces; **Inset Blush** (`surface-2`): fields, secondary actions, and grouped choices.
- **Fine Blush Line** (`border`): card boundaries and dividers; **Strong Blush Line** (`border-2`): field boundaries and hover emphasis.
- **Plum Ink** (`foreground`): primary text; **Muted Plum** (`muted`): descriptions, labels, and supporting metadata. Dark counterparts become pale ink and dusty plum against darker surfaces.
- **White** (`white`): filled action labels and switch thumbs.
- **Skeleton Blush** (`skeleton-base`, `skeleton-hi`): the two stops used by loading placeholders.

### Semantic and provider exceptions

- **Jade Success**, **Amber Warning**, **Rose Danger**, and **Orchid Information** (`success`, `warning`, `danger`, `info`): state text and indicators; badges use a 15% tint of their semantic color. These communicate status rather than additional brand accents.
- **AniList Green**, **MangaDex Gold**, and **MyAnimeList Blue** (`provider-*`): fixed provider identity accents from the shared utilities. Provider badges use a small matching dot and a tinted background; solid badges over imagery use a dark scrim.
- Images use black scrims with white labels for overlays such as page counts. Their contrast is independent of the surrounding theme.

## Typography

**Body and interface font:** Inter, with Segoe UI and system sans-serif fallbacks.
**Technical font:** JetBrains Mono, with Cascadia Code and monospace fallbacks.

Both fonts are self-hosted variable WOFF2 assets. Inter carries the full interface hierarchy; mono is reserved for logs and technical output. The hierarchy is compact and mostly sentence case, using weight and spacing rather than a separate display face. The base body is 14px; explicit utility roles below establish their own line heights.

### Hierarchy

- **Headline** (24px / 32px, 600, tight tracking): page headings paired with a 40px rounded icon chip and an optional subtitle.
- **Title** (14px / 20px, 600, tight tracking): card and section headings. Standard dialog titles use the larger dialog-title role (16px / 24px); gallery detail dialogs locally use 18px with a snug line height.
- **Body** (14px / 20px, 400): descriptive copy, metadata, and normal controls. Field values may use medium weight locally.
- **Label** (12px / 16px, 500): field labels, badges, and supporting labels. Metadata comparison labels additionally use uppercase and wider tracking; this is local to comparison rows.
- **Micro label** (10px / 14px, 500): tiny overlay chips. Do not promote this size to ordinary instructions or field labels; the version stamp has a separate tight line height.
- **Button** (14px, 500, line height 1.25): default action labels; small buttons locally use 12px.
- **Metric** (30px / 36px, 600): Tasks summary counts, with tabular numerals.
- **Mono** (12px / 16px, 400): job logs and technical output. Counts and percentages elsewhere use tabular numerals without changing font families.

There is no separate marketing display scale or system-wide prose measure in the current app.

## Layout

The application fills the viewport using dynamic viewport height. The body stays fixed while the main content region scrolls. The desktop sidebar is 240px wide from 1024px; below that, a 56px header and an off-canvas navigation drawer replace it. The drawer is at most 256px wide, constrained by the viewport, and honors safe-area insets.

Page inset padding grows from 12px to 20px at 640px and 32px at 1024px. Cards use 12px internal padding, growing to 16px at 640px. The spacing vocabulary follows Tailwind's 4px base unit with 2px half-steps for dense details; recurring gaps are 4px, 8px, 12px, and 16px. There is no single global maximum content width.

Standard breakpoints are 640px, 768px, 1024px, 1280px, and 1536px. Local 360px and 420px breakpoints serve choice labels and Discover covers. Libraries uses two cover columns by default, then three at 640px, four at 768px, five at 1280px, and six at 1536px. Discover uses a single column below 420px with a compact horizontal cover layout, then two, three, four, five, and six columns at 420px, 768px, 1024px, 1280px, and 1536px. Both use 12px grid gaps.

Page headings stack on narrow screens and allow actions to wrap. Choice groups scroll horizontally instead of widening the page. Settings tabs remain sticky inside the content scrollport. Long text wraps, and most truncation and line clamping are relaxed below 1024px; dense tables retain local truncation. The Libraries title clamp is implemented locally and should not be assumed to inherit every global clamping override.

Controls have compact desktop sizes, but below 1024px or with a coarse pointer, buttons, fields, selects, navigation links, and disclosures have a minimum 44px height. Icon-only buttons also receive a 44px minimum width. Do not force the compact desktop control height onto touch layouts.

## Elevation & Depth

Depth comes from tonal layers with subtle structural shadows. Fine borders separate persistent cards, while small shadows distinguish controls from their background. Raised buttons lift slightly under a fine-pointer hover; interactive cards deepen their shadow. Dialogs and toasts occupy a stronger floating layer with dark scrims and larger shadows.

### Shadow vocabulary

- **Control at rest:** `0 1px 2px var(--control-shadow)`.
- **Raised control on hover:** `0 3px 8px var(--control-shadow)`, with a 1px upward translation.
- **Card at rest:** `0 2px 6px var(--card-shadow)`.
- **Interactive card on hover:** `0 4px 14px var(--control-shadow)`.
- **Toast:** the installed Tailwind large shadow; **dialog:** the installed Tailwind 2xl shadow. Exact values and theme-specific shadow inks are in the sidecar.

**The The Local Feedback Rule.** Press feedback stays on the control. Pointer hover may lift raised buttons; reduced motion removes transforms and effectively stops animation.

Ordinary press feedback scales controls to 0.98; icon buttons use 0.94. State transitions generally take 160ms, presses 80ms, and selection indicators 220ms. Page entrance uses a short upward fade (500ms); tab panels enter once as a unit (220ms) without remounting forms. Dialog content opens in 280ms and closes in 160ms. Loading shimmer is an intentional repeating state. Reduced motion removes control transforms, stops indicator transitions, and reduces animations and other transitions to near-zero duration.

## Shapes

Soft corners establish a consistent form language. Small inset regions and thumbnails use 4px or 6px corners. Buttons, fields, navigation items, and toasts use 8px; cards and page icon chips use 12px; standard dialogs use 16px. Badges, switches, selection dots, and progress tracks use fully rounded silhouettes. Fine 1px borders define most surfaces.

Cover cards use a 3:4 image region with clipped upper corners; the surrounding title and metadata stay outside the image. The Tasks detail drawer is a deliberate full-height rectangular exception. Native selects retain their OS dropdown while the closed field receives an inline chevron.

## Components

### Buttons

Softly rounded, precise, and quietly tactile. The shared component offers default, outline, ghost, danger, and secondary variants.

- **Shape and sizing:** 8px corners; default 36px height and 12px horizontal padding. Small keeps 36px height with 10px padding and 12px labels; large is 40px high with 16px padding; icon is 36px square before touch minimums apply.
- **Primary:** filled Sakura Rose and white labels; hover uses the separate filled-button hover color.
- **Outline:** a surface background, strong border, and foreground label; hover fills the inset surface.
- **Ghost:** muted text and a transparent background; hover adds an inset surface and foreground text.
- **Secondary:** inset surface and foreground text; hover uses a 60% border-color tint.
- **Danger:** danger fill with white text in light mode; dark mode uses background-colored text. Hover reduces opacity to 90%.
- **States:** disabled controls reduce opacity to 50% and suppress pointer interaction. Raised variants use the rest/hover shadows and local press feedback described above.

### Cards / containers

Rounded surfaces that organize dense work. Standard cards have 12px corners, a surface fill, a fine border, and the subtle card shadow. Headers and content supply their own 12px padding, rising to 16px at 640px; the bare card has no intrinsic padding. Header dividers use the same fine border. Interactive variants strengthen the border and shadow on hover. Cover-card selection adds a primary outline and a visible selection mark.

### Inputs / fields

Inset fields use a strong border, an inset surface, 8px corners, 36px height, and 12px horizontal padding. Placeholder text uses muted ink at 70% opacity. Focus changes the border to primary and the fill to surface. Disabled fields keep their geometry with 50% opacity and a disabled cursor. Selects share these styles and reserve space for their chevron. The primitive has no automatic error variant; screens supply semantic inline error messages.

**The The Single Focus Rule.** Use the shared keyboard focus outline. Fields merge it into their border; choice groups draw it inward. Do not stack an additional ring over that indicator.

The global focus outline is 2px wide using a 70% primary mix in sRGB, offset by 2px. Fields use a primary outline offset inward by 1px to merge with the field border; radio and tab groups use an inward 2px offset to remain visible in their scroll container.

### Chips / badges

Compact pills use 12px medium-weight labels, 8px horizontal and 2px vertical padding, and a 4px internal gap. Default and muted variants use the inset surface; status variants use a 15% semantic tint and matching text. Matched maps to success, unmatched to muted, syncing to warning with a spinner, and failed to danger. Provider badges add a colored dot and a provider identity accent. Page counts use a black 70% scrim with white tabular text over covers.

### Navigation

The primary sidebar uses 36px rows, 8px corners, 16px outline icons, and 14px text. Active routes use a 10% primary tint, primary text, and medium weight. Inactive rows use muted text; hover uses a 70% inset-surface tint and foreground text. Mobile navigation is a labeled modal drawer with focus trapping, Escape dismissal, and inert background content. Preserve theme controls, account controls, and connection/status information as part of the shell.

### Tabs and segmented choices

Tabs use an underline indicator, a fine lower border, muted inactive labels, and primary active labels. Labels are 12px on narrow screens and 14px from 640px. The indicator moves in 220ms; keyboard arrows, Home, and End change the selected tab and move focus. Segmented radio choices instead use an inset rounded group with a raised surface indicator. Both patterns scroll horizontally when needed and preserve focus inside the scroll area.

### Metadata comparison

This signature pattern makes review concrete. At 640px and above, each field is a three-column row: a 7rem label column, current value, and proposed value. Below that it stacks. Fine row dividers, uppercase labels, checkboxes, wrapped values, and paired covers keep comparison legible. Changed rows receive a warning tint; differing current values become muted and struck through, while proposed values use primary. Deselected proposals become muted and struck through. Tag merging highlights incoming tags while keeping existing tags readable.

### Dialogs, feedback, and loading

Standard dialogs use a 50% black overlay, a surface fill, a fine border, 16px corners, and a stronger shadow. Their base maximum width is 64rem, with viewport-safe width and height margins; screens can override this for comparisons, confirmations, or the Tasks drawer. Titles, descriptions, close labels, and Radix keyboard behavior remain part of the component contract.

Toasts sit above dialogs in the upper-right corner, use 8px corners, 12px padding, a semantic left border, and a visible countdown. Success and information last 5 seconds; errors last 10 seconds. Empty states use a centered icon, compact title, and optional muted explanation. Error states add a semantic danger icon and optional retry. Skeletons shimmer using their dedicated theme tokens; progress bars use a pill-shaped inset track and a primary fill.

## Do's and Don'ts

### Do:

- **Do** use semantic CSS variables so surfaces, text, borders, and states follow the selected theme.
- **Do** preserve the separate primary and primary-button roles, especially in dark mode.
- **Do** use existing button, field, card, badge, tab, and disclosure primitives for consistent states.
- **Do** retain visible keyboard focus, labeled icon actions, and text labels alongside status colors.
- **Do** preserve the 44px minimum touch target rules and the reduced-motion behavior.
- **Do** allow long titles, paths, and errors to wrap; keep dense table truncation local to tables.
- **Do** keep current and proposed metadata visibly distinct, with field selection before applying changes.

### Don't:

- **Don't** use the pale dark-theme primary color as a white-text filled-button background.
- **Don't** add a second focus ring on top of the global keyboard focus outline.
- **Don't** hard-code light-theme surface or text colors into app components.
- **Don't** replace the installed Inter and JetBrains Mono fonts with a runtime CDN dependency.
- **Don't** apply pointer hover lift to touch controls or retain transforms under reduced motion.
- **Don't** treat external cover art or the screenshot sample counts as product-owned assets or measured results.
