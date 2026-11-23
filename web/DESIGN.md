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
  "success": "#066350"
  "warning": "#80490a"
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

<!-- impeccable:design-map -->
Name: H-Tosho
Colors: primary: primary #aa386a; neutral: background #fcf4f7; semantic: success #066350; provider: provider-anilist #02b968; primary: primary-hover #902a57; primary: primary-button #aa386a (+34 more in the sidecar)
Fonts: Inter (headline, title, dialog-title, body, label, micro-label, button, metric); JetBrains Mono (mono)
Spacing: 1 0.25rem, 2 0.5rem, 3 0.75rem, 4 1rem, 5 1.25rem, 8 2rem, 0.5 0.125rem, 1.5 0.375rem, 2.5 0.625rem
Radius: sm 0.25rem, md 0.375rem, lg 0.5rem, xl 0.75rem, 2xl 1rem
North Star: "The Sakura Library"
Rules:
- The The Two Pink Roles Rule. Use the semantic primary token for text, indicators, and translucent highlights; use primary-button for filled actions with white text.
- The The Local Feedback Rule. Press feedback stays on the control.
- The The Single Focus Rule. Use the shared keyboard focus outline.
Elevation:
- Control at rest: 0 1px 2px var(--control-shadow)
- Raised control on hover: 0 3px 8px var(--control-shadow)
- Card at rest: 0 2px 6px var(--card-shadow)
- Interactive card on hover: 0 4px 14px var(--control-shadow)
- Toast: the installed Tailwind large shadow; dialog: the installed Tailwind 2xl shadow.
Don't:
- Don't use the pale dark-theme primary color as a white-text filled-button background.
- Don't add a second focus ring on top of the global keyboard focus outline.
- Don't hard-code light-theme surface or text colors into app components.
- Don't replace the installed Inter and JetBrains Mono fonts with a runtime CDN dependency.
- Don't apply pointer hover lift to touch controls or retain transforms under reduced motion.
- Don't treat external cover art or the screenshot sample counts as product-owned assets or measured results.
Do:
- Do use semantic CSS variables so surfaces, text, borders, and states follow the selected theme.
- Do preserve the separate primary and primary-button roles, especially in dark mode.
- Do use existing button, field, card, badge, tab, and disclosure primitives for consistent states.
- Do retain visible keyboard focus, labeled icon actions, and text labels alongside status colors.
- Do preserve the 44px minimum touch target rules and the reduced-motion behavior.
- (+2 more)
Map: src/index.css
Map: src/components/ui.tsx
Map: src/App.tsx
Map: src/pages/
Map: .impeccable/design.json
Full: .impeccable/design-full.md (read a section when you need its detail)
