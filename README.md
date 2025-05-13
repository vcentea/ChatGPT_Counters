# ModelMeter

A browser extension that tracks and displays ChatGPT model usage limits.

## Features

- Tracks message counts for different ChatGPT models (GPT-4o, GPT-4o mini, etc.)
- Displays current model usage in a convenient bubble UI
- Detects and processes rate limit banners to update quotas automatically
- Detailed in-page panel showing usage for all models
- Support for both FREE and PLUS ChatGPT plans
- Auto-resets counters when quotas refresh

## Technical Details

The extension consists of:
- Background service worker for tracking and storing usage data
- Content script for monitoring ChatGPT API usage and UI elements
- Timestamp utilities for managing quota periods
- Storage utilities for persistent data management

## Installation

Load the extension from the `/extension` directory as an unpacked extension in your browser's developer mode.

## License

Apache 2.0 