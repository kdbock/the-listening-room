# vinext-starter

A clean full-stack starter running on
[vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and
Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

## Firebase

This project is prepared for a shared Firestore-backed workflow.

1. Copy `.env.example` to `.env.local`
2. Confirm the Firebase web app values for `the-listening-room-b5a70`
3. Use Firestore for shared workflow state and keep large source audio in iCloud

Current Firebase wiring lives in:

- `lib/firebase/config.ts`
- `lib/firebase/client.ts`
- `lib/firebase/collections.ts`

## Local Qwen Rendering

The hosted app is the control panel. It can be used anywhere to review scenes,
approve voices, sound cues, ambience, and queue a render job.

Voice generation stays local. New render jobs are written to Firestore with
`render_target: "local_qwen"`. They do not call OpenAI voice APIs and they are
not picked up by the Cloud Run worker.

Run the local worker on the Mac that has the Qwen environment and local voice
references:

```bash
cd /Users/kristykelly/Documents/Pangea/Scene\ Studio/audiobook-dashboard
npm run render:local
```

The worker reads queued `local_qwen` jobs, renders narration with:

```text
local-narrator/scene-studio/scene_tts_renderer.py
```

Then it reads approved `sfx_cues` and `ambience_cues`, runs a local Qwen
sound-designer pass when the local instruct model is installed, falls back to a
deterministic local planner when needed, matches the resulting search terms
against the local sound archive index, and writes:

- `sound-design-plan.json`
- `02-effects.wav`
- `03-ambience.wav`
- `with-sfx.wav`
- `final-mix.wav`

Audio saves under:

```text
local-narrator/cloud-renders/
```

Use this split intentionally:

- At work or away from the render machine: review, edit, approve, and queue.
- At home on the render Mac: run `npm run render:local` to create the audio.
- Finished local files can be uploaded later if they need to play from another
  device.

This starter does not use `wrangler.jsonc`.

## Included Shape

- edit site code under `app/`
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

OpenAI workspace sites can read the current user's email from
`oai-authenticated-user-email`.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm run render:local`: watch Firestore for local Qwen render jobs
- `npm test`: build the starter and verify its rendered loading skeleton
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
