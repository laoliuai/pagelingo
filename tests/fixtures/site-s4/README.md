# Declared S4 samples

`samples.json` is an explicit synthetic acceptance set. The HTML, arXiv Atom bodies and small PDF are own contract fixtures. They do not impersonate public responses. `paper.pdf` and `paper-v2.pdf` are copies of `source.pdf` from the unchanged released S3 ZIP; identical bytes across two version declarations exercise explicit local package binding and history.

The released S2/S3 ZIP paths point to the original tracked files. Preflight validates every path/type/size/hash and reads them without modification. At least one declared PDF bundle is required for the populated 001–006 upgrade baseline. Use a new output directory whose parent exists:

```sh
npm run build:site
npm run build:extension
npm run check:site:s4 -- --samples tests/fixtures/site-s4/samples.json --output /tmp/pagelingo-s4-new-run
```

Each sample declares `id`, `kind` (`synthetic`, `cached-public`, or `live-public`), `format` (`html`, `github`, `arxiv`, or `bundle`), source `url`, fixed `version`, actual `file`/`sha256`/`capturedAt`, `expected.scope`/`contains`, `resources`, and `unverified`. Paths resolve relative to the declaration. GitHub/arXiv primary responses also declare `responseUrl`, `accept`, and `mediaType`; each resource declares URL, file/hash, role, media type and optional Accept value. This disambiguates GitHub's same-URL descriptor/raw/rendered responses. `cached-public` must contain actual retained public responses. `live-public` first re-fetches only declared URLs through the production bounded pinned transport, retains actual responses, and rejects changed bytes before creating services.

Limits: UTF-8 declaration ≤1 MiB; 1–32 samples; ≤256 resources per sample; all local inputs ≤512 MiB. HTML ≤8 MiB, images/CSS ≤16 MiB, JSON ≤16 MiB, small source text/Atom ≤1 MiB, PDF/ZIP ≤256 MiB. GitHub repository metadata ≤1 MiB, README descriptor ≤2 MiB, raw README/commit ≤1 MiB and rendered README ≤8 MiB; GitHub API responses require explicit recognized Accept values. HTML and GitHub captures also retain 64 MiB/256 files/16 origins limits. Regular files only; symlinks, repeated inode aliases/hardlinks and existing output paths are rejected. Streamed hash checks precede output creation; readers recheck file identity and hash. Samples are processed sequentially, with at most one bounded HTML response buffered for native browser delivery.

The harness creates its own named Docker volume/database and temporary object store. It ignores ambient site/database/provider configuration and never reads `.env` files. It stops owned writers before migration, recreates the database/API, and injects SIGKILL at applicable durable acquisition/export/purge boundaries. The default synthetic set has no GitHub root sample, so acquisition interruption requires a declared GitHub root. The test records explicit lease-clock advancement after killing owned workers; it does not change production clocks. All model providers reject calls. Python is unused. Logs, trace, actual IDs, hashes, screenshots and interruption evidence are written under the new output. Input files are checked again after use.
