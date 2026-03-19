# Profanity Filter WebExtension

A Firefox WebExtension that automatically detects profanity in subtitles, mutes audio during profanity, and displays censored subtitles overlaying the video.

## Features

- **Subtitle Upload**: Load SRT, ASS, or WEBVTT subtitle files
- **Profanity Detection**: Detect explicit language using wordlists, regex patterns, and fuzzy matching
- **Audio Control**: Automatically mute the tab when profanity is detected
- **Censored Overlay**: Display subtitles with profanity replaced by `[CENSORED]`
- **Timing Sync**: Adjust subtitle timing with real-time preview
- **Privacy-First**: All processing happens locally in your browser

## Installation

### From Source

1. Clone this repository
2. Run `npm install` to install dependencies
3. Run `npm run build` to build the extension
4. Open Firefox and navigate to `about:debugging`
5. Click "This Firefox" → "Load Temporary Add-on"
6. Select the `manifest.json` file from the `dist` folder

### Development

```bash
npm run dev      # Build and watch for changes
npm run test     # Run tests
npm run lint     # Lint code
npm run format   # Format code
```

## Usage

1. Click the extension icon to open the popup
2. Click "Options" to open the settings page
3. Upload your subtitle file (SRT, ASS, or WEBVTT)
4. Adjust the profanity detection sensitivity as needed
5. Use the offset slider to sync subtitles with video
6. Play your video and enjoy profanity-free viewing

## Keyboard Shortcuts

- `Alt+Left`: Decrease subtitle offset (show subtitles earlier)
- `Alt+Right`: Increase subtitle offset (show subtitles later)

## Privacy

This extension is designed with privacy as the primary concern:

- **No external servers**: All subtitle processing is done locally
- **No telemetry**: No usage data is sent anywhere
- **No network calls**: The extension works completely offline
- **Local storage only**: Settings and subtitles are stored in browser storage

Optional features (like auto-fetching subtitles) require explicit user opt-in.

## License

MIT License - see [LICENSE](LICENSE) file for details.