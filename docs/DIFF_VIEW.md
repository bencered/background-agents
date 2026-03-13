# Diff View — Design & Implementation Notes

**Demo**: [diff-view-demo.html](./diff-view-demo.html) (open locally or deploy to any static host)  
**Last deployed**: https://sandy-pulsar-p6wz.here.now/ (expires 24h from 2026-03-13)

## Architecture

### Diff Capturing

- Run `git diff origin/<baseBranch>` in the sandbox after each tool call (debounced 500ms)
- Gives ground truth — covers all file changes regardless of tool (Edit, Write, apply_patch, shell)
- Store latest snapshot in DO storage (fast reads), write-through to D1 for persistence
- Broadcast `diff_snapshot` events over existing WebSocket

### Rendering

- **Library**: `@pierre/diffs` (npm: `@pierre/diffs`, docs: https://diffs.com/docs)
- **React**: `MultiFileDiff`, `PatchDiff`, `FileDiff` from `@pierre/diffs/react`
- **Vanilla JS**: `FileDiff`, `parsePatchFiles`, `parseDiffFromFile` from `@pierre/diffs`
- Renders into Shadow DOM via `<diffs-container>` custom element

### Key APIs Used

- `parsePatchFiles(patch)` — parse unified diff string into `FileDiffMetadata[]`
- `parseDiffFromFile(oldFile, newFile)` — diff two `FileContents` objects
- `FileDiff.render({ fileDiff, containerWrapper, lineAnnotations })` — render
- `renderAnnotation(annotation)` — custom DOM element for inline comments
- `unsafeCSS` — inject CSS into Shadow DOM (for line highlights, gutter button)
- `enableLineSelection` + `onLineSelectionEnd` — multi-line selection
- `renderHoverUtility` — floating hover element (limited positioning control)

### Shadow DOM Selectors (for `unsafeCSS`)

```css
/* Line rows */
[data-line="N"]                          /* any line by number */
[data-line-type="change-addition"]       /* added lines (green bg) */
[data-line-type="change-deletion"]       /* deleted lines (red bg) */
[data-line-type="context"]               /* unchanged lines */

/* Columns within a line */
[data-column-number]                     /* gutter / line number */
[data-column-content]                    /* code content */
[data-line-number-content]               /* inner span with number text */

/* Annotations */
[data-diffs-annotation]                  /* annotation wrapper */
[data-line-annotation]                   /* line annotation slot */

/* Selection */
[data-selected-line="true"]              /* selected lines */
```

### Comment System (Custom, built on top of diffs.com)

- Comments stored as `{ id, startLine, endLine, side, author, text, createdAt }`
- Rendered via `renderAnnotation` — annotation placed on `endLine`
- Commented lines highlighted blue via `unsafeCSS` overriding theme colors
- "+" button in gutter via CSS `::before` pseudo-element on `[data-column-number]`
- Gutter click handler via `shadowRoot.addEventListener('click')` on `[data-column-number]`
- Inline comment input rendered as a "pending" annotation with `_isPending: true` metadata

### Design System (matches background-agents)

- Background: `#1a1a1a`
- Foreground: `#f8f8f6`
- Accent: `#a68b6a` (warm brown)
- Borders: `rgba(255,255,255,0.1)`
- Muted text: `#666` / `#999`
- Comment highlight: `rgba(56, 139, 253, 0.25)` (blue)
- No border-radius (sharp/industrial)
- Font: system + SF Mono for code

### diffs.com Limitations

1. `renderHoverUtility` positions element in a floating slot — cannot place in gutter
2. Theme line colors (green/red) need `!important` override on child elements
3. `unsafeCSS` wrapped in `@layer unsafe` (lower priority) — `!important` required
4. No built-in comment/review system — must build on `renderAnnotation` + `lineAnnotations`
5. **Open issue #306**: custom gutter columns (blame, annotations) — not yet supported
6. No inline comment threading natively

### Related Issues

- diffs.com #306 — Custom gutter columns for per-line metadata
- diffs.com #331 — Collapse/expand individual file diffs
- background-agents #342 — OpenCode slash commands (/compact, /model, /cost)

## Files

- `docs/diff-view-demo.html` — standalone demo (vanilla JS, loads @pierre/diffs from esm.sh CDN)
- `packages/web/src/app/demo/diff/page.tsx` — React version (Next.js route, uses
  @pierre/diffs/react)
