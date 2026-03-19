### Task Overview
Create a single autonomous agentic plan to design, implement, test, and deliver a Firefox WebExtension that: **accepts a user-supplied subtitle file**, **detects profanity in cues**, **temporarily mutes the current tab while profanity is playing**, **renders censored subtitles overlaying the video**, and **lets the user shift subtitle timing**. All processing must run locally in the browser by default and respect user privacy.

---

### Goals and Acceptance Criteria
**Primary goals**
- **Upload subtitle file**: user can upload SRT/ASS/WEBVTT via Options UI; cues stored locally.
- **Profanity detection**: detect profanity in cues with configurable sensitivity and obfuscation handling.
- **Audio control**: mute/unmute the current tab precisely for profanity cue durations.
- **Subtitle overlay**: display subtitles on-screen with profanity replaced by **[CENSORED]**.
- **Sync control**: provide a real-time offset slider and manual shift controls; changes apply immediately.
- **Local-first privacy**: no external uploads by default; optional opt-in features only.

**Acceptance criteria**
1. Upload and parse SRT/ASS/WEBVTT files; produce cue list `{start, end, text}` within 2s for 10k cues.
2. Mute/unmute latency ≤ 150 ms from cue start when video is playing.
3. Overlay updates at video frame rate; censored words replaced with **[CENSORED]**.
4. Offset adjustments apply immediately and persist in extension storage.
5. Extension uses only `tabs`, `storage`, `activeTab`, and minimal host permissions; no external network calls unless user opts in.
6. Automated tests for parsing, detection, mute/unmute, and offset behavior included.

---

### Agent Task Sequence
1. **Project scaffolding**
   - Create repo and branch structure.
   - Add `README`, license, and issue templates.
   - Create initial `manifest.json` (Manifest V3) with required permissions: `tabs`, `storage`, `activeTab`, and host match patterns `*://*/*` for content script injection (minimize scope later).
2. **Core modules**
   - **Parser**: implement SRT/ASS/WEBVTT parser producing normalized cues.
   - **Profanity engine**: implement layered detector (wordlist + regex + fuzzy).
   - **Overlay renderer**: content script to render subtitles and apply censorship.
   - **Sync controller**: offset slider and real-time preview logic.
   - **Mute controller**: background/service worker to mute/unmute tab via `browser.tabs.update(tabId, { muted: true/false })`.
3. **UI**
   - Options page for upload, wordlist editing, sensitivity, offset, and opt-in features.
   - Popup for quick enable/disable and per-site presets.
4. **Messaging and storage**
   - Define message protocol between content script and background: `requestCues`, `muteNow`, `unmuteNow`, `updateOffset`, `status`.
   - Store cues and settings in `browser.storage.local` with schema versioning.
5. **Performance and robustness**
   - Precompute cue index (binary search or interval tree) for O(log n) lookup.
   - Use `requestAnimationFrame` loop to poll `video.currentTime` and update overlay.
   - Debounce mute/unmute messages to avoid rapid toggling.
6. **Optional features**
   - TF.js contextual classifier (opt-in).
   - WASM Levenshtein for faster fuzzy matching.
   - Auto-fetch subtitles from OpenSubtitles API (opt-in).
7. **Testing and release**
   - Unit tests for parser and detector.
   - Integration tests on YouTube, Vimeo, HTML5 players, and local files.
   - Prepare Firefox Add-ons submission package and privacy statement.

---

### Technical Design and Stack
**Stack**
- **Extension platform**: Firefox WebExtension Manifest V3 (service worker background).
- **Languages**: TypeScript for extension code; CSS for overlay styling.
- **Libraries**: small, local-only libs:
  - **srt/ass parser**: lightweight JS parser (or custom).
  - **Levenshtein**: WASM or JS implementation for fuzzy matching.
- **Build**: Vite or esbuild; ESLint; Prettier.
- **Testing**: Jest for unit tests; Playwright for integration tests.

**Permissions**
- `tabs` — mute/unmute.
- `storage` — save cues and settings.
- `activeTab` — on-demand injection.
- Host permissions limited to pages where content script runs; request minimal scope.

**Data model**
- `storage.local` keys:
  - `cues_v1`: array of cues `{id, startMs, endMs, text, profanityScore, censoredText}`
  - `settings`: `{offsetMs, sensitivity, fuzzyThreshold, wordlist, enabledSites, optInTFJS}`
  - `presets`: per-site settings

---

### Implementation Details and Protocols
**Manifest skeleton**
- `manifest.json` includes `background.service_worker`, `content_scripts` for `video` pages, `options_ui`, `action` (popup), and `permissions`.

**Message protocol**
- Content → Background:
  - `{type: "muteNow", tabId, reasonId}`
  - `{type: "unmuteNow", tabId, reasonId}`
  - `{type: "requestCues", tabId}`
- Background → Content:
  - `{type: "cues", cues, settings}`
  - `{type: "muted", tabId, untilMs}`

**Profanity detection algorithm**
1. **Normalize** text: lowercase, strip punctuation except obfuscation characters.
2. **Exact match**: tokenized words vs wordlist.
3. **Regex rules**: handle obfuscation patterns like `f[\W_]*u[\W_]*c[\W_]*k`.
4. **Fuzzy match**: compute Levenshtein distance; mark as profanity if `distance/length <= fuzzyThreshold` (default 0.25).
5. **Score and threshold**: compute `profanityScore` combining matches; flag cue if `score >= sensitivity`.
6. **Censoring**: replace matched spans with `[CENSORED]` preserving spacing.

**Example regex patterns**
- Obfuscation: `f[\W_]*u[\W_]*c[\W_]*k`
- Character substitutions: map `@`→`a`, `0`→`o`, `1`→`i` before matching.

**Overlay rendering**
- Inject a fixed-position container above video with `pointer-events: none` except for settings UI.
- Render current cue with censored text; animate fade in/out.
- Provide keyboard shortcuts for quick offset adjustments (`Alt+Left`, `Alt+Right`).

**Mute/unmute logic**
- Content script detects entering a profanity cue window (apply offset).
- On entering: send `muteNow` to background with `tabId` and `expectedUnmuteAt`.
- Background mutes tab and sets a safety timer to unmute if no `unmuteNow` arrives.
- On leaving: send `unmuteNow`; background unmutes only if no other active profanity cues are present.

**Sync and offset**
- Offset applied as `effectiveTime = video.currentTime + offsetMs/1000`.
- Provide live preview: show next 3 cues and allow dragging offset until visual sync is correct.

---

### Testing Deployment Security and Privacy
**Testing matrix**
- Players: YouTube, Vimeo, Netflix (DRM behavior noted), local HTML5 video, embedded players.
- Scenarios: single cue profanity, overlapping cues, rapid-fire profanity, obfuscated profanity, long files, large cue counts.
- Metrics: mute latency, false positive rate, CPU/memory usage.

**Security**
- Avoid injecting into `about:` pages and browser UI.
- Sanitize all parsed subtitle text before DOM insertion.
- Limit host permissions; request broader host access only when user enables “auto-apply on all sites”.

**Privacy**
- Default: all processing local; no external calls.
- Optional opt-in features (subtitle fetch from OpenSubtitles/Subscene) must be explicit and reversible.
- Provide clear privacy statement in Options and README.

**Release checklist**
- Automated tests passing.
- Linting and build artifacts.

---

### Deliverables Timeline and Outputs
**Week 1**
- Repo, manifest, basic parser, background mute/unmute, simple overlay, Options upload UI.
- Deliverable: working MVP that mutes tab for exact-word matches and shows censored overlay.

**Week 2**
- Add fuzzy detection, offset UI, performance optimizations, unit tests.
- Deliverable: polished extension with offset control and robust detection.

**Week 3**
- Integration tests, WASM fuzzy acceleration, packaging, documentation.
- Deliverable: release candidate and submission package.

**Final deliverables**
- Source repo with branches, tests.
- Build artifacts for Firefox Add-ons.
- Documentation: README, privacy statement, user guide, developer notes.
- Test report with latency and false-positive metrics.

---

### Execution Instructions for the Agent
- **Operate autonomously**: follow the Task Sequence and Acceptance Criteria; create git commits for each milestone
- **Prioritize privacy and local processing**.
- **Log progress**: commit messages and PR descriptions must reference the milestone and include test evidence.
- **Deliver artifacts**: packaged XPI, test logs, and a short deployment guide.

Use this prompt as the single agentic plan to implement, test, and deliver the Firefox profanity-filter WebExtension end-to-end.
