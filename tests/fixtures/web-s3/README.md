# Declared S3 acceptance fixtures

`samples.json` names eight own-content UTF-8 HTML fixtures: Chinese and English
blog articles, X main posts, Zhihu standalone answers, and WeChat articles.
The X and Zhihu fixtures contain excluded sibling/quoted content. WeChat uses
`data-src`; all eight use the same valid 4×3 RGBA PNG as a local data resource.
The PNG was generated from explicit RGBA scanlines and standard PNG chunks.
Code and MathML are preserved alongside ordinary text.

These are controlled adapter fixtures, not downloaded site pages, accounts,
login sessions, or evidence that a live site currently has this DOM. The native
acceptance harness replays their exact declared SHA256 bytes with a UTF-8 HTTP
content type, exercises production capture and resource acquisition, and asserts
that the Reader decodes the archived image. External source scripts do not run.

Run from the repository root after site and extension builds:

```sh
npm run check:web-capture -- --samples tests/fixtures/web-s3/samples.json --output /tmp/pagelingo-web-new-run
```

Cached public inputs are declared separately in ignored local evidence. Do not
copy full third-party pages into these fixtures. Mock provider output establishes
structural and lifecycle behavior only, not linguistic quality.
