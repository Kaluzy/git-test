# Nia call relay v2

Caller-scoped Telnyx callback memory, reviewed live thread lookup, durable note
capture, and queued Notion call logging. This branch extends the original
`git-test` repository with Nia's backend; it does not place calls or send texts.

**Release status, October 11, 2026:** source and local tests are prepared.
Production relay deployment, provider credentials, and controlled voice
acceptance are still required. The live Nia assistant's speech/IVR rules were
updated separately; that does not make these service endpoints live.

## Start here

- [Architecture and behavior](NIA-LIVE-MEMORY.md)
- [Deployment, acceptance, and recovery guide](docs/OPERATIONS.md)
- [Environment template](.env.example)
- [Generic import format](config/threads.example.json)

Use Node 22.x and the locked dependencies:

```sh
npm ci --ignore-scripts
npm test
node scripts/import-threads.mjs --help
node scripts/operate.mjs --help
```

The tests use injected providers and private in-memory storage. They do not
place calls, send messages, write the real Notion log, or establish production
hosting connectivity. The operations guide describes the separate live gates.

Real credentials, caller numbers, transcripts, and private import files belong
in protected runtime settings or private storage. Only generic examples are
committed here. Preserve the existing Notion database and seed already-saved
conversations before replaying events.

