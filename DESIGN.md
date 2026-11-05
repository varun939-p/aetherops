# Design System: AetherOps Enterprise SRE Command Center

## 1. Visual Theme & Atmosphere
An institutional, high-density SRE diagnostic command center ("Cockpit Dense" 8/10, "Offset Asymmetric" 5/10, "Fluid Micro-Motion" 6/10). The interface combines clinical precision with zero visual noise—structured like a mission-critical observability and code-remediation console where every telemetry metric, fault marker, and line-range diff is immediately scannable.

## 2. Color Palette & Roles
### Light Mode (Default Institutional Slate)
- **App Backdrop** (`#F3F4F6`) — Outer viewport frame and recessed structural gutters
- **Canvas Pure** (`#FFFFFF`) — Primary code viewport, active workspaces, and card surfaces
- **Surface Slate** (`#FBFBFC`) — Explorer and triage side panes, sticky table headers
- **Hover Wash** (`#F2F4F7`) — Interactive row hover and segmented control track
- **Structural Line** (`#E4E7EC`) — 1px hairlines separating panes, rows, and telemetry cells
- **Strong Line** (`#D0D5DD`) — Control borders, inputs, and interactive pills
- **Deep Slate Ink** (`#101828`) — Primary typography and active headings (never `#000000`)
- **Muted Slate** (`#475467`) — Secondary body text, issue descriptions, and code context
- **Subtle Steel** (`#667085`) — Metadata labels, timestamps, and file paths
- **Cobalt Signal Accent** (`#1D4ED8`) — Single primary accent for CTAs, active tabs, and focus rings (saturation controlled, zero neon glow)
- **Semantic Severity Palette:**
  - **Critical Fault** (`#D92D20` text / `#FEF3F2` fill) — Security breach, RCE, SQLi, or crash
  - **High Risk** (`#C4320A` text / `#FFF4ED` fill) — Production reliability or N+1 hazard
  - **Medium Warning** (`#B54708` text / `#FFFAEB` fill) — Timeout or resource degradation
  - **Low Advisory** (`#3E4784` text / `#EEF4FF` fill) — Maintainability and code hygiene
  - **Verified Clean** (`#067647` text / `#ECFDF3` fill) — Zero open findings / healthy subsystem

### Dark Mode (`[data-theme="dark"]` Carbon Obsidian)
- **App Backdrop** (`#08090B`) — Deep carbon frame (never `#000000`)
- **Canvas Obsidian** (`#0B0C0F`) — Primary code and diff surface
- **Surface Graphite** (`#101216`) — Explorer and issue triage panes
- **Raised Slate** (`#15171C`) — Elevated controls, dropdowns, and cards
- **Structural Line** (`#1F2228`) — 1px structural dividers
- **Primary Ink** (`#E8E9EC`) — High-contrast primary text
- **Cobalt Signal Accent** (`#6B9CF5`) — Calibrated dark-mode accent

## 3. Typography Rules
- **Display & UI Sans:** `Geist` (`--font-geist-sans`) — Track-tight (`-0.015em`) for headers and metric callouts; clean weight contrast (`500` medium for controls, `600` semibold for headers).
- **Monospace & Telemetry:** `Geist Mono` (`--font-geist-mono`) — Mandatory for all source code, line numbers, SHA-256 hashes, rule IDs (`SEC-INJ-001`), file paths, latency figures, and tabular numeric counters (`font-variant-numeric: tabular-nums`).
- **Banned:** `Inter`, generic serif fonts (`Times New Roman`, `Georgia`, `Garamond`).

## 4. Component Stylings
- **Buttons & Controls:** Tactile `-0.5px` active press feedback, crisp `1px` borders, minimum `32px–36px` desktop click target (`44px` on touch viewports), zero outer neon glow.
- **Telemetry Strip Cards:** High-density 6-column institutional strip with visual health progress bars, severity micro-badges, and keyboard-accessible info tooltips (`Hint`).
- **Explorer Rows:** Virtualized 32px rows with dual-encoded status glyphs (shape + color: diamond for critical, square for issues, circle for clean, hollow ring for changed) and hover quick-actions (`Analyze`, `Delete`).
- **Code & Diff Viewport:** Virtualized fixed-height rows with sticky line-number gutters, severity gutter bars, zoom controls (`Ctrl +`/`Ctrl -`/wheel), and instant toggle between `Code` and `Proposed fix` (`Inline` unified / `Side by side` split).
- **Empty & Onboarding States:** Structured 3-step interactive onboarding guide card with one-click sample file launch and clear workspace linking actions.

## 5. Layout Principles
- Full-viewport locked `100dvh` (`h-dvh`) CSS Grid layout (`[Header] -> [Telemetry Strip] -> [Status/Alert Bar] -> [3-Pane Main Workspace] -> [Status Footer]`).
- Zero horizontal page overflow; independent virtualized scroll containers for Explorer, Code Viewport, and Issue Triage panes.
- Responsive drawer overlays on `< 1280px` and `< 768px` viewports.

## 6. Motion & Interaction
- Hardware-accelerated `transform` and `opacity` transitions (`150ms cubic-bezier(0.22, 1, 0.36, 1)`).
- Indeterminate sweep bar during live syncs and NDJSON batch scans.
- Subtle pulse indicator on active `Analyzing…` states and live system health dots.

## 7. Anti-Patterns (Banned)
- No emojis in UI chrome
- No `Inter` or serif fonts
- No pure `#000000` black
- No purple/blue neon button glows
- No synthetic/hardcoded telemetry numbers (all metrics strictly bound to `/api/stats` and `/api/system`)

