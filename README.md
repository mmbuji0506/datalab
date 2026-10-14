# DataLab Workbench

An early, local-first prototype of a no-code data workbench. The current slice supports importing and inspecting small CSV/TSV files, checking and repairing data quality, preparing data with a replayable change history, training and honestly evaluating simple models, and discovering groups. Imported data is processed in the browser and is not uploaded by the app.

## Run locally

Requires Node.js 24 or later.

```sh
npm install
npm run dev
```

## Checks

```sh
npm test            # unit, oracle, fuzz, journey, and render smoke tests
npm run lint
npm run build
npm run journey     # narrated end-to-end walkthrough on a messy sample file
npm run benchmark
```

Tests use Node's built-in test runner and TypeScript type stripping; no test framework dependency is required. Statistical and model code is checked against independent reference values from NumPy, SciPy, and scikit-learn (see `tests/fixtures/make-oracle.py`; the generated `oracle-models.json` is committed, so Python is only needed to regenerate it). The UI smoke test server-renders the real components; it does not click through a browser.

## Current scope

**Import and inspect**

- CSV and TSV import with quoted-field parsing, UTF-8 BOM handling, duplicate-header normalization, input validation, and automatic detection of comma, semicolon, tab, and pipe delimiters.
- Local previews (up to 8 rows), column profiles, and inferred column types (numeric, integer, boolean, date, categorical, identifier, text, constant, empty).
- Per-column median, standard deviation, skewness, IQR outlier counts, and distribution sketches.
- Local bar and donut visualizations with configurable grouping and sum, mean, or row-count aggregation.
- Pearson and Spearman correlation for up to eight numeric columns, with complete-pair counts and two-sided p-values.

**Data quality**

- A 0-100 quality score with a transparent formula (completeness, uniqueness, consistency, validity) and a list of findings, each with a one-click fix where one exists: missing values, "N/A"-style markers, numbers stored as currency/percent/thousands text, stray whitespace, mixed-case spellings, outliers, duplicate rows, constant and identifier-like columns.
- Imputing a column that may be a prediction target is flagged as risky, because it invents answers.

**Prepare**

- Rename, fill, median/mean/mode imputation, mark missing markers, convert text to numbers, merge spelling variants, trim, cap or remove outliers, drop missing rows, deduplicate, min-max and z-score scaling, one-hot encoding, date-part extraction, column removal, row filters, append and join.
- Every change is a recorded step: multi-level undo, restore-to-source, and a recipe file (JSON) that replays the same preparation on another file with the same columns. Recipe files are strictly validated before use.
- CSV export neutralizes cells that spreadsheets could run as formulas (leading `=`, `+`, `-`, `@`); this can be turned off.

**Model lab**

- Ridge regression, logistic regression (multiclass), and depth-limited decision trees (CART), trained in the browser on seeded shuffled or file-order splits, with stratification for classes.
- Features are scaled and encoded using training rows only, so held-out rows never influence the fitted model.
- Reports held-out metrics beside a no-skill baseline (MAE/RMSE/R² or accuracy/macro-F1), k-fold cross-validation (forward-chaining for time-ordered data), a confusion matrix with per-class precision/recall/F1, permutation feature importance, and linear coefficients.
- A permutation test states how often chance alone would score as well, so a small lucky margin on few rows is labelled "could be luck" rather than "beats the baseline".
- Warnings for tiny samples, class imbalance, too few rows per feature, suspected target leakage, and models that do not beat the baseline. Held-out predictions can be downloaded.

**Clustering**

- k-means with k-means++ starts, standardized columns, silhouette scores to suggest a cluster count, and an optional recorded step that adds a `cluster` column.

## Prototype limits

- Files are limited to 25 MiB, 50,000 rows, 100 columns, and 32,000 characters per cell.
- Model training uses a seeded sample above 20,000 rows, at most 80 encoded columns, and 20 classes. Training runs on the main thread, so large runs briefly pause the page.
- Models are deliberately simple and interpretable. Random forests, gradient boosting, neural networks, AutoML, hyperparameter search, and model persistence are not implemented. Scores describe the supplied rows and say nothing about future data.
- ISO dates (`YYYY-MM-DD`) are recognized; ambiguous day/month formats are not guessed. Ambiguous decimal commas (`1,5`) are refused rather than converted.
- Excel, Parquet, database/object-store connectors, persistence, authentication, APIs, server execution, and distributed processing are not implemented.
- Data is held in memory; reloading the page clears the current session. Export a prepared CSV, and save a recipe, to keep your work.
- This prototype does not provide the approved security foundation for hosted team access or connector credentials. Do not enter secrets or sensitive datasets.

## Performance check

Run `npm run benchmark` to exercise a deterministic dataset matrix: 50,000 mixed rows, 20,000 dirty rows with duplicates/missing values/quoted text, and a 2,500-row by 100-column wide table. It measures median parse, profile, quality analysis, cleaning, normalization, filter, aggregation (including 50,000 unique groups), Pearson and Spearman correlation, recipe replay, 50,000-row join/append, baseline evaluation, model training (ridge, logistic, tree, with and without cross-validation), k-means, and export after warm-up. Results depend on the machine and runtime. This does not measure 100+ GB data, connector pushdown, or distributed execution.

The broader product requirements and open decisions are recorded in `.azure/project-plan.md`. This prototype implements only a bounded local/offline slice and does not imply that the full workbench or 100+ GB support is available.
