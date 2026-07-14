# The Listening Room Cloud Run render worker

This worker is the bridge between:

- the hosted Listening Room app on Vercel
- the shared Firestore / Firebase Storage project
- the future true audio renderer

What it does right now:

- looks for queued records in `render_jobs`
- claims one so two workers do not grab the same job
- loads the book and scene from Firestore
- writes a render package into Firebase Storage
- marks the render job completed

What it does not do yet:

- generate the final WAV
- run multi-voice synthesis
- mix sound effects and ambience

That next stage should replace the placeholder `renderScenePackage()` function in
`server.mjs`.

## Endpoints

- `GET /healthz`
- `POST /process-next`
- `POST /process-batch`

## Environment variables

Set these in Cloud Run:

- `GOOGLE_CLOUD_PROJECT`
- `FIREBASE_STORAGE_BUCKET`

Optional, if not relying on the Cloud Run default service account:

- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`

Optional:

- `RENDER_BATCH_SIZE`

## Deploy shape

Suggested first deployment:

1. Create a Cloud Run service from this folder
2. Give it access to Firestore and Firebase Storage
3. Set `FIREBASE_STORAGE_BUCKET` to your Firebase bucket
4. Call `POST /process-next` manually to test
5. Confirm a `render-plan.json` file appears under:

   `renders/<bookId>/<sceneId>/<jobId>/render-plan.json`

## Why this first

This gives The Listening Room a real render queue backbone before the final audio
engine is connected. Once this is working, the hosted app stops pretending and
starts handing work to an actual processor.
