# Scene Studio

Scene Studio is a local-first audiobook production workspace for preparing scenes,
identifying speakers, managing character voice profiles, rendering narration, and
planning layered sound design.

## Applications

- `local-narrator/scene-studio` contains the local Python scene-production app.
- `audiobook-dashboard` contains the web dashboard.
- `tools` contains manuscript and audio-production utilities.

The local scene app can be opened on macOS with
`local-narrator/Open Pangea Scene Studio.command`.

## Local production data

Manuscripts, generated audio, voice references, production workspaces, caches, and
review renders are intentionally excluded from Git. They remain in the working
folder on the production machine and are not uploaded to GitHub.
