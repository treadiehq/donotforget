# Do Not Forget

A local-first macOS app that captures text from any app into recording sessions. Select text, copy it, and it's saved — no cloud, no sync, just your notes on your machine.

## Features

- **Text capture** — records selected and copied text from any app while a session is active
- **Markdown editor** — edit and organize captured content with a live preview
- **AI-powered** — optional smart summaries, content enhancement, and session chat (OpenAI, Anthropic, Google)
- **Share links** — generate local URLs to share sessions from your machine
- **Search** — find anything across all sessions with `Cmd+K`
- **Privacy first** — all data stays in local SQLite, nothing leaves your machine

## Setup

```bash
# Install dependencies
cd app && bun install && bun run rebuild:native

# Build the native helper
cd ../native-helper && swift build

# Run the app
cd ../app && bun dev
```

On first launch, grant Accessibility permissions when prompted — this lets the helper capture selected text from other apps.

## Package for macOS

```bash
cd app && bun run package
```

The `.dmg` installer will be in `app/release/`.

## How it works

The app runs an Electron shell with a native Swift helper. The helper uses macOS Accessibility APIs to read selected text and monitors the clipboard as a fallback. Captured text flows over a local WebSocket into SQLite.

## License

[FSL-1.1-MIT](LICENSE)
