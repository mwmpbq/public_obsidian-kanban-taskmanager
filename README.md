# Kanban Taskmanager

An Obsidian plugin that brings all your tasks together into a single, switchable Kanban board.

## Features

- Board view that groups tasks into columns.
- Create, move, and reorder cards on the board.
- Card detail view for reading and editing a task.
- Today view that focuses on what is due.
- Done handling that respects task hierarchies.

## Requirements

- Obsidian 1.13.0 or newer.
- Desktop only.

## Installation

### Via BRAT (recommended)

1. Install the BRAT community plugin and enable it.
2. Run the command "BRAT: Add a beta plugin for testing".
3. Enter the repository `mwmpbq/public_obsidian-kanban-taskmanager`.
4. Enable "Kanban Taskmanager" under Settings, Community plugins.

BRAT updates the plugin automatically whenever a new release is published.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Copy them into `<vault>/.obsidian/plugins/kanban-taskmanager/`.
3. Reload Obsidian and enable the plugin under Settings, Community plugins.

## Building from source

```
npm install
npm run build
```

The build produces `main.js` from the sources in `src/`.

## Releases

Releases are built from a version tag. Pushing a tag runs the workflow in
`.github/workflows/release.yml`, which builds the plugin and publishes a
release with `main.js`, `manifest.json`, and `styles.css` attached. The tag
name and the version in `manifest.json` must match.

## License

Released under the MIT License. See `LICENSE`.
