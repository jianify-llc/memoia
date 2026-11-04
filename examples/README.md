# TypeScript example

Build/install the repository SDK and Worker tooling, then run `src/worker/node_modules/.bin/tsx examples/quickstart.ts` from the repository root with explicit environment values. The user must already belong to the authenticated project. This is a real API example and may invoke the configured model; local verification does not execute it.

Keep the operation key, message identity and message time stable across deliberate replays. If the write outcome is unknown, query `getOperationByKey` before recovering it. The example logs only IDs, status and counts; the SDK supports complete Facts, Events, Profiles, source evidence, message deletion, correction and permanent user forgetting.
