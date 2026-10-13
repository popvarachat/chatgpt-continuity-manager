# Thailand EV adoption and national oil demand — research ledger
Date: 2026-10-13. Status: INCOMPLETE — no causal estimate computed. This is not a final research finding.

## Question
Does an increase in the share of BEVs in Thailand's comparable in-use vehicle fleet cause a reduction in aggregate petroleum consumption relative to a no-additional-BEV counterfactual?

## Official sources confirmed
- DLT cumulative registered vehicles, by vehicle class and fuel, snapshot 2026-02-28: https://gdcatalog.dlt.go.th/th/dataset/dataset_1_1_04 . This single snapshot is insufficient for a time-series regression.
- EPPO monthly refined-oil consumption (gasoline/diesel/products), official CSV catalog: https://catalog.eppo.go.th/th/dataset/dataset_11_15 . Catalog describes historical series and may lag current period.

## Definitions and pitfalls
- Numerator: BEV in-use stock by vehicle class, not year-on-year growth in new registrations.
- Denominator: all active vehicles of the same class, same date, excluding inactive registrations.
- Outcome A: gasoline liters/month. Outcome B: road diesel liters/month. Outcome C: all petroleum products, separately reported because aviation/industrial consumption cannot be attributed to road EVs.
- Sales volumes may proxy consumption but are not identical to end-use.
- BEV fleet share is not share of vehicle-kilometers: control for VKT, usage patterns, HEV/PHEV, fuel prices, GDP, tourism, freight activity, vehicle stock, seasonal patterns, policy and trend.
- Distinguish observed decline from avoided consumption against a counterfactual.
- Avoid interpreting a simple national time-trend correlation as causation.

## Analysis plan
1. Retrieve original monthly CSV files, preserve source URLs, retrieval timestamps, checksums, definitions and revision dates.
2. Build monthly panel 2019–2026 where available; use exact same calendar coverage and vehicle classes.
3. QA missing values, fuel unit conversion, product overlap, duplicated registrations, and historical breaks.
4. Estimate baseline with month fixed effects, trend, prices, macro and mobility controls; use autocorrelation-robust standard errors and sensitivity checks. Report effect size and confidence intervals, not only p-values.
5. Triangulate physical displacement = active BEV stock × annual km × substitution fraction / displaced ICE km per liter, stratified by vehicle type. Do not treat all BEVs as passenger cars.
6. Counterfactual forecast with and without BEV expansion; show uncertainty, placebo tests and alternative lags. Be explicit that observational models cannot guarantee causality.
7. Publish raw-data manifest, processing scripts, model outputs, charts, methodology, limitations, and executive summary.

## Evidence status
Official catalogs identified; raw historical data not yet downloaded and harmonized in this run. No regression, p-value, causal effect or completed proof exists. Do not present the hypothesis as proven or disproven.

## Completion gate
Only mark COMPLETE after raw files, harmonized dataset, reproducible script, validated statistical output, sensitivity analysis and reviewed conclusion are committed. Human gate for external publication if required.
