# S3 actual UI evidence

These screenshots are from native Chromium running the built extension and site,
backed by the actual API/private ObjectStore and an independent mock worker.
They are screenshots of working UI, not design mockups.

- `extension-connected.png`: disposable test account paired through the real API;
  no user credentials or model keys are shown.
- `blog-en-reader.png`: own-content English synthetic adapter fixture; the mock
  label is deliberately visible. The checker separately asserts native PNG decode,
  code text, and MathML rendering.
- `wechat-zh-reader.png`: own-content Chinese synthetic WeChat adapter fixture;
  no translation job or model request is needed.
- `public-blog-1-reader.png`: archived Reader from the immutable anonymous public
  HTML collected on 2026-10-27, with missing resources and warnings visible. This is
  not a current logged-in source-page screenshot or a complete-source claim.

`acceptance-summary.json` records the declared inputs, actual check times, hashes,
scope/resource results, selected output hashes, and explicit unverified boundaries.
Full raw traces/logs stay in ignored local acceptance directories. No complete
third-party HTML, device token, runtime keyring, or original ZIP is included here.
