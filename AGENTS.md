# Repository Guidelines

## Project Structure & Module Organization

PageLingo combines browser translation, reading assistance, and experimental PDF processing.

- `apps/extension/src/`: Manifest V3 extension, React UI, DOM adapters, and background jobs. Tests and fixtures live in `apps/extension/tests/`.
- `packages/translation-core/` and `packages/assistant-core/`: reusable SDKs, each with `src/` and `tests/`. Keep browser APIs, DOM access, and persistence adapters outside these packages.
- `packages/document-contracts/schemas/`: P0 parser and source-layout schemas.
- `services/document-parser/`: Python parser sources, tests, and `uv.lock`.
- `benchmarks/pdf/`: parser evaluation and preview tools; `docs/`: specifications and guides; `examples/`: SDK examples; `scripts/`: build and integration utilities.
- `apps/web/` and `apps/document-service/` contain planning READMEs.

## Build, Test, and Development Commands

Use Node.js 24+; PDF tooling requires Python 3.12 and `uv`. Run commands from the repository root:

- `npm ci`: install locked workspace dependencies.
- `npm run dev`: build SDKs and start extension development.
- `npm run build`: build SDKs and the production extension in `apps/extension/dist/`; reload the extension and refresh webpages afterward.
- `npm run package:extension`: build and package an installable ZIP.
- `npm run check`: run TypeScript checks, unit tests, standalone package tests, and browser tests.
- `npm run pdf:setup`: install the base parser environment; `npm run pdf:lint` and `npm run pdf:test` run Ruff and pytest.

## Coding Style & Naming Conventions

Use strict TypeScript with ESM imports, two-space indentation, single quotes, and semicolons. Use camelCase for functions, PascalCase for types/components, and kebab-case module filenames. Python uses four spaces and snake_case; Ruff enforces the configured checks and 100-character line limit. Match existing file style.

## Testing Guidelines

Vitest covers SDK and extension units; Playwright covers Chromium integration; Node's test runner verifies independent SDK packages; pytest covers parsing. Name tests `*.test.ts`, `*.test.mjs`, or `test_*.py`, respectively. Add behavior-focused regressions for fixes. No numeric coverage threshold is configured. Run relevant checks; consult `benchmarks/pdf/tools/README.md` for PDF layout validation. Standard tests use mocks; `test:llm*` scripts contact real APIs.

## Commit & Pull Request Guidelines

History uses concise, type-prefixed subjects such as `chore: establish PageLingo project baseline`; follow this pattern with `feat:`, `fix:`, or `chore:`. PRs should describe resulting behavior, affected modules, and validation results; link related issues when available. Include screenshots for UI/layout changes and update documentation.

## Configuration & Generated Artifacts

Keep credentials in ignored `.env.local`; use `.env.example` as the template. Respect ignored parser runs, PDFs, model weights, and releases. Preserve original parser outputs and manifests; write reprojections and previews to new directories.
