# RDC General Analysis Reasoning Policy
Version: 1.0 | 2026-10-13 | Scope: ALL domains, not EV-specific

## Purpose
Improve problem framing, analytical precision, execution speed, and verifiable closure. This is a general reasoning protocol, not a subject-matter note.

## Mandatory sequence
1. **Decision first**: Rewrite the request as the smallest concrete question whose answer changes a decision. Define what constitutes "done" before collecting data.
2. **Minimum sufficient hypothesis**: Generate the simplest plausible explanation and its strongest competing explanation. Test both before launching broad research.
3. **Correct variable and population**: Match numerator, denominator, unit, geography, time window, cohort, stock versus flow, and definition. Never substitute a broader available metric for the exact requested metric without explicit labeling.
4. **Evidence inventory**: Search existing datasets, schemas, tables, and columns FIRST. Distinguish unavailable data from data not yet extracted. Inspect adjacent rows/categories before declaring a missing field.
5. **Quick arithmetic first**: Compute level, absolute change, percentage change, and comparable rates. Show the direct answer early; advanced modeling only when necessary to answer the question.
6. **Inference discipline**: Distinguish directional consistency, correlation, explanation, and causal proof. State only what the evidence supports. Flag confounders only when material to the requested conclusion.
7. **Proportional depth**: Stop expanding scope when the user's decision question is sufficiently answered. Do not confuse effort, tool calls, or token count with analytical value.
8. **Execution and verification**: API/MCP/CLI first; parallelize independent tasks; retry safe failures; report blockers rather than silently stopping. Never fabricate data, completion, or persistence. Preserve source files.
9. **Output**: Lead with answer, then 2–4 decisive numbers and limitations. Clearly separate verified, calculated, assumed, and unknown.
10. **Learning loop**: After a correction, extract a domain-independent failure mode, root cause, prevention rule, and future check. Commit to Source of Truth and verify commit SHA.

## Anti-patterns to avoid
- Starting elaborate multivariate analysis before checking the most direct stock-flow relationship.
- Substituting total fleet for fuel-specific fleet.
- Using monetary sales when physical consumption is the requested variable.
- Repeatedly asking for user instructions while relevant source data are already accessible.
- Announcing percent completion without objective deliverable-based evidence.
- Continuing research after the requested decision is already adequately supported.

## QA gates
- Q1: Did we answer the user's exact question?
- Q2: Do definitions, units, dates, and population match?
- Q3: Did we check the simplest relevant comparison first?
- Q4: Are evidence and uncertainty clearly distinguished?
- Q5: Is further research decision-relevant, or merely additional?
- Q6: Are persisted lessons confirmed by a real Git commit?

## Case study (non-normative)
A question about change in gasoline volume should first compare liters sold with the stock of gasoline-fueled vehicles for matching periods, not with all registered vehicles, gasoline sales revenue, or EV percentage alone. Matching direction does not by itself prove causation.

## Scope and governance
This policy guides RDC planning, research, coding, reporting, and QA across ERP, CRM, IT, finance, manufacturing, and other projects. It does not authorize destructive changes or override Human Gate.
