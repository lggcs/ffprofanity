# Profanity Filter WebExtension

A Firefox WebExtension that automatically detects profanity in subtitles, mutes audio during profanity, and displays censored subtitles overlaying the video.

## Features

- **Subtitle Upload**: Load SRT, ASS, or WEBVTT subtitle files
- **Auto-Detection**: Automatically detects subtitles on supported streaming sites
- **Profanity Detection**: Multi-layered detection using:
  - Wordlist matching (exact)
  - Obfuscation patterns (regex)
  - Fuzzy matching (Levenshtein distance)
  - Context-aware filtering (religious terms whitelist)
- **Audio Control**: Automatically mute the tab when profanity is detected
- **Censored Overlay**: Display subtitles with profanity replaced by `[CENSORED]` or fun alternatives
- **Timing Sync**: Adjust subtitle timing with real-time preview
- **Privacy-First**: All processing happens locally in your browser

## Supported Sites

The extension can automatically detect and extract subtitles from:

- **YouTube** (auto-generated and uploaded captions)
- **Jellyfin** (local and remote instances, HLS streams, native and embedded subtitles)
- **LookMovie**
- **FMovies**
- **PlutoTV** (partial)
- **123Chill** (partial)

## Installation

### From Source

1. Clone this repository
2. Run `npm install` to install dependencies
3. Run `npm run build` to build the extension
4. Open Firefox and navigate to `about:debugging`
5. Click "This Firefox" → "Load Temporary Add-on"
6. Select the manifest file from the `dist` folder

### For Production (Signed XPI)

```bash
npm run package
```

This creates `artifacts/ffprofanity-1.0.0.xpi` for distribution.

## Development

```bash
npm run dev        # Build for development
npm run build      # Build for production (creates XPI)
npm run test       # Run test suite
npm run test:watch # Run tests in watch mode
```

### Project Structure

```
src/
├── background/       # Service worker (mute control, message routing)
├── content/          # Content script (overlay rendering, video sync)
├── popup/            # Toolbar popup UI
├── options/          # Settings page UI
├── extractors/       # Site-specific subtitle extractors
├── page-scripts/     # Injected scripts for streaming sites
└── lib/              # Core libraries
    ├── detector.ts   # Profanity detection engine
    ├── parser.ts     # Subtitle format parsers (SRT/VTT/ASS)
    ├── cueIndex.ts   # O(log n) time-based lookup
    ├── storage.ts    # Extension storage helpers
    ├── substitutions.ts # Fun word replacements
    └── wordlist.ts   # Profanity wordlist
```

### Tech Stack

- **Language**: TypeScript
- **Build**: esbuild (fast bundling)
- **Test**: Vitest with jsdom
- **Platform**: Firefox WebExtension Manifest V3

## Usage

1. Click the extension icon to open the popup
2. Click "Options" to open the settings page
3. Upload your subtitle file (SRT, ASS, or WEBVTT) - or use auto-detection
4. Adjust the profanity detection sensitivity:
   - **High**: Mute entire caption when profanity detected
   - **Medium**: Mute only the profanity word (balanced buffering)
   - **Low**: Mute only the profanity word (minimal buffering)
5. Choose substitution style:
   - `[CENSORED]` text
   - Fun alternatives (silly, polite, random, monkeys)
6. Use the offset slider to sync subtitles with video
7. Play your video and enjoy profanity-free viewing

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+Left` | Decrease subtitle offset |
| `Alt+Right` | Increase subtitle offset |

## Testing

The project has 109 tests covering:

- Subtitle parsing (SRT, VTT, ASS formats)
- Profanity detection (exact, fuzzy, obfuscation patterns)
- Profanity window timing calculations
- Cue index time-based lookups

```bash
npm run test
```

## Privacy

This extension is designed with privacy as the primary concern:

- **No external servers**: All subtitle processing is done locally
- **No telemetry**: No usage data is sent anywhere
- **No network calls**: The extension works completely offline
- **Local storage only**: Settings and subtitles are stored in browser storage
- **No tracking**: No analytics or third-party scripts

## Permissions

The extension requests minimal permissions:

| Permission | Purpose |
|------------|---------|
| `storage` | Save settings and subtitles |
| `tabs` | Mute/unmute tab audio |
| `activeTab` | Access current tab for overlay |
| `webNavigation` | Detect page loads for auto-extraction |
| `webRequest` | Intercept subtitle network requests |

## License

MIT License - see [LICENSE](LICENSE) file for details.
