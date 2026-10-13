# Thailand EV Fleet Share vs Petroleum Sales — Preliminary Research Report
**Research date:** 2026-10-13  
**Status:** Preliminary / not causal / original raw data not fully obtained.  
**Prepared from:** Codex Corporate analysis in Notebook workspace `Documents/EV-Oil-Research/REPORT.md`. This is a readable executive extract, not a verbatim copy of the full local report.

## Research question
Does rising battery-electric-vehicle (BEV) share in Thailand cause a decrease in national gasoline, diesel, or petroleum sales?

## Official-source-derived evidence
DLT accumulated registrations (September 30, 2022 vs September 30, 2023):
- Electricity-only vehicles: 24,570 → 99,742
- All registered vehicles: 43,152,117 → 44,179,926
- BEV share of all vehicles: 0.05694% → 0.22576%
- BEV share of private passenger cars up to 7 seats: 0.08723% → 0.53974%

EPPO petroleum-product sales (2023 compared with 2022; day-weighted annual averages):
- Gasoline: +3.98%
- Diesel: −5.67%
- Gasoline + diesel: −2.85%
- Total petroleum products: +0.71%

For January–September matched windows, gasoline +4.88%, diesel −4.49%, total petroleum +2.15%.

## Statistical analysis
Matched monthly comparisons across 2022 and 2023 were performed. Jan–Sep month-paired t-tests after Holm correction: gasoline p=0.02473, diesel p=0.09361, total petroleum p=0.13879. Quarter-block sign-flip tests were inconclusive (gasoline p=0.25, diesel p=0.50, total p=0.25). These tests compare sales between years, **not an EV effect**.

## Conclusion
The available data do not establish that EV adoption caused a change in Thai petroleum consumption. Two observed fleet snapshots are insufficient for meaningful BEV–fuel regression, elasticity, or causal inference. It is possible for EVs to displace fuel relative to a no-EV counterfactual while aggregate fuel sales increase for unrelated reasons.

## Data-quality limitations
- Fleet snapshots only September 2022 and September 2023; monthly fuel sales 2022–2023 (24 observations).
- Original PDF/CSV downloads failed owing to network/proxy restrictions; analysis relies on indexed text/table extracts. The 2022 DLT snapshot came from a mirror of an official annual report.
- Sales are not measured road-vehicle fuel burn; petroleum totals include jet fuel, LPG and non-road consumption.
- Economic activity, vehicle kilometers, fuel prices, freight, tourism, and other confounders were not controlled.
- This report is not publication-ready and should not be presented as causal evidence.

## References
- [DLT annual report (2023 table)](https://www.dlt.go.th/web-upload/1xff0d34e409a13ef56eea54c52a291126/m_document/187/5600/file_download/89d51e91e5e92ce5879c37d933b85aa8.pdf)
- [DLT annual report 2022 mirror](https://anyflip.com/bmolp/zcjv/basic/101-120)
- [EPPO Energy Statistics 2024](https://eppo.d-gis.com/wp-content/uploads/2026/04/EnergyStatistics2024.pdf)
- [EPPO petroleum statistics](https://www.eppo.go.th/data-energy-statistic/energy-statistic/oil-energy-stat/petroleum/)
- [DLT vehicle fleet dataset catalog](https://gdcatalog.dlt.go.th/dataset/dataset_1_1_04)

## Next required steps
Acquire verified monthly DLT fleet counts and EPPO petroleum series over multiple years, class-match BEV exposure to road fuels, include macro/fuel-price/traffic controls, assess trend and serial correlation, and establish a credible counterfactual before making a causal claim.
