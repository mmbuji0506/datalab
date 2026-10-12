# DataLab Workbench

An early, local-first prototype of a no-code data workbench. The current slice supports importing and inspecting small CSV/TSV files, applying basic table changes, and checking simple prediction baselines. Imported data is processed in the browser and is not uploaded by the app.

## Run locally

Requires Node.js 24 or later.

```sh
npm install
npm run dev
```

## Checks

```sh
npm test
npm run lint
npm run build
```

Tests use Node's built-in test runner and TypeScript type stripping; no test framework dependency is required.

## Current scope

- CSV and TSV import with quoted-field parsing, UTF-8 BOM handling, duplicate-header normalization, and input validation.
- Local previews (up to 8 rows), column profiles, missing-value counts, and duplicate-row counts.
- In-memory column rename, missing-value fill, column removal, row filters, restore-to-imported-source, and CSV export.
- Local bar and donut visualizations with configurable grouping and sum, mean, or row-count aggregation.
- Simple mean regression and majority-class baselines using the first 80% of rows for training and the remainder for testing.

## Prototype limits

- Files are limited to 25 MiB, 50,000 rows, 100 columns, and 32,000 characters per cell.
- Excel, Parquet, database/object-store connectors, persistence, authentication, APIs, server execution, trained ML models, and distributed processing are not implemented.
- Baseline evaluation is a diagnostic constant predictor, not a trained model or a claim of production model quality.
- Data is held in memory; reloading the page clears the current session. Export a prepared CSV to keep a copy.
- This prototype does not provide the approved security foundation for hosted team access or connector credentials. Do not enter secrets or sensitive datasets.

## Performance check

Run `npm run benchmark` to exercise a deterministic dataset matrix: 50,000 mixed rows, 20,000 dirty rows with duplicates/missing values/quoted text, and a 2,500-row by 100-column wide table. It measures median parse, profile, fill/filter, transforms, aggregation (including 50,000 unique groups), regression/classification baseline evaluation, and export after warm-up. Results depend on the machine and runtime. This does not measure 100+ GB data, connector pushdown, or distributed execution.

The broader product requirements and open decisions are recorded in `.azure/project-plan.md`. This prototype implements only a bounded local/offline slice and does not imply that the full workbench or 100+ GB support is available.
