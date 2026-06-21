---
name: hackathon_pipeline
description: "Ultra-lean 5-phase execution optimizing for free-tier token limits."
---

# Execution Protocol

## Phase 1: Contract & Math Gate
1. **SOTA_Research_Scout**: Extract allocation/routing math to `docs/UVP_BLUEPRINT.md`.
2. **Define Schema**: Establish fixed JSON contract (Inputs: type, loc, time -> Outputs: duration, severity, units, nodes). **[GATE: User Approval]**

## Phase 2: Parallel Scaffold
### Track A: Backend & OR
3. **Spatial_Temporal_Feature_Engineer**: Run data pipeline (UTC->IST) + generate `synthetic_data_generator.py`.
4. **Core_Backend_Model_Architect & Resource_Optimization_Solver**: Jointly train predictive models, wrap in FastAPI, and pipe predictions into PuLP/NetworkX routing.
### Track B: UI
5. **Premium_UX_Dashboard_Auditor**: Scaffold Streamlit UI using hardcoded mock data matching Phase 1 schema.

## Phase 3: Integration & Pruning
6. **Integration**: Connect Streamlit UI to live FastAPI endpoints.
7. **Product_Feature_Success_Auditor**: Run edge-case audit. Strip low-impact UI metrics. Supervise adding "Available Police Force" manual sliders. Immediate refactor by Devs.

## Phase 4: Leakage & QA Guard
8. **QA_Review_Architect**: Run MyPy/PyTest. Execute strict data leakage audit: ensure target metrics (`resolved_datetime`) are completely isolated from features available at time of incident.

## Phase 5: Handover
9. **Product_Feature_Success_Auditor**: Compile clean repo `README.md` (with Mermaid.js diagram) and 3-min pitch deck text. Freeze code.