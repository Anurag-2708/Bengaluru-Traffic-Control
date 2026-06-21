"""
main.py — FastAPI application entry point for the Traffic Incident & Event Co-Pilot.

Mounts the frontend static files, exposes REST endpoints for data/charts/hotspots,
and provides the /api/chat endpoint for conversational AI queries.

Run with:
    uvicorn main:app --reload --port 8000
"""

import logging
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import data_engine
import cluster_engine
import llm_service

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("main")

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(
    title="Traffic Incident & Event Co-Pilot API",
    description="Backend API for the GridGuard traffic incident and event analytics dashboard.",
    version="1.0.0",
)

# CORS — allow all origins for development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Startup event
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def startup_event():
    """Log data load status on application startup."""
    row_count = len(data_engine.df)
    col_count = len(data_engine.df.columns)
    logger.info(
        "✅ Data loaded: %d rows, %d columns from %s",
        row_count,
        col_count,
        data_engine._csv_resolved,
    )


# ---------------------------------------------------------------------------
# Request/Response models
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    """Request body for the /api/chat endpoint."""
    message: str
    history: list = []


class ChatResponse(BaseModel):
    """Response body for the /api/chat endpoint."""
    response: str
    tool_calls_made: list = []


# ---------------------------------------------------------------------------
# Chat endpoint
# ---------------------------------------------------------------------------

@app.post("/api/chat", response_model=ChatResponse)
async def chat_endpoint(req: ChatRequest):
    """Handle a conversational AI query.

    Accepts a user message and optional conversation history,
    runs the LLM tool-calling loop, and returns the model's response.
    """
    try:
        result = await llm_service.chat(
            user_message=req.message,
            history=req.history,
        )
        return ChatResponse(**result)
    except Exception as exc:
        logger.exception("Chat endpoint error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Data endpoints
# ---------------------------------------------------------------------------

@app.get("/api/data/summary")
async def data_summary(min_samples: int = 20):
    """Return a high-level summary including cluster and trending zone counts."""
    try:
        summary = data_engine.get_summary()
        # Add cluster and trending counts for the stats footer
        hotspots = cluster_engine.compute_hotspots(min_samples=min_samples)
        trending = cluster_engine.get_trending_hotspots(min_samples=min_samples)
        summary["clusters_detected"] = len(hotspots)
        summary["trending_zones"] = len(trending)
        # Format date range as a readable string
        dr = summary.get("date_range", {})
        if isinstance(dr, dict) and dr.get("start") and dr.get("end"):
            start_str = dr["start"][:10] if dr["start"] else "?"
            end_str = dr["end"][:10] if dr["end"] else "?"
            summary["date_range"] = f"{start_str} → {end_str}"
        return summary
    except Exception as exc:
        logger.exception("Summary endpoint error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/data/columns")
async def data_columns():
    """Return the list of columns in the dataset."""
    return data_engine.get_columns()


@app.get("/api/data/sample")
async def data_sample(n: int = 100):
    """Return a random sample of rows from the dataset."""
    return data_engine.get_data_sample(n=n)


# Chart data dispatcher
_CHART_HANDLERS = {
    "violations_by_type": data_engine.get_violations_by_type,
    "violations_by_month": data_engine.get_violations_by_month,
    "violations_by_station": lambda: data_engine.get_violations_by_station(n=10),
    "violations_by_vehicle": data_engine.get_violations_by_vehicle,
    "violations_by_hour": data_engine.get_violations_by_hour,
    "violations_by_day_of_week": data_engine.get_violations_by_day_of_week,
}


# Key mappings: which dict key holds the label for each chart type
_LABEL_KEYS = {
    "violations_by_type": "type",
    "violations_by_month": "month",
    "violations_by_station": "station",
    "violations_by_vehicle": "vehicle_type",
    "violations_by_hour": "hour",
    "violations_by_day_of_week": "day",
}


@app.get("/api/data/charts/{chart_type}")
async def chart_data(chart_type: str):
    """Return chart data for a given chart type.

    Returns {labels: [...], values: [...]} format for Chart.js.
    """
    handler = _CHART_HANDLERS.get(chart_type)
    if handler is None:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown chart type '{chart_type}'. "
                   f"Valid types: {', '.join(_CHART_HANDLERS.keys())}",
        )
    try:
        raw = handler()
        # Transform [{label_key: ..., count: ...}] into {labels, values}
        label_key = _LABEL_KEYS.get(chart_type, "type")
        labels = [str(item.get(label_key, "")) for item in raw]
        values = [item.get("count", 0) for item in raw]
        return {"labels": labels, "values": values}
    except Exception as exc:
        logger.exception("Chart endpoint error for '%s': %s", chart_type, exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/data/charts/{chart_type}/cluster/{cluster_id}")
async def cluster_chart_data(chart_type: str, cluster_id: int, min_samples: int = 20):
    """Return chart data for a specific cluster."""
    if chart_type not in _CHART_HANDLERS:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown chart type '{chart_type}'. "
                   f"Valid types: {', '.join(_CHART_HANDLERS.keys())}",
        )
    try:
        return cluster_engine.get_cluster_chart(cluster_id, chart_type, min_samples=min_samples)
    except Exception as exc:
        logger.exception("Cluster chart endpoint error for '%s' cluster %d: %s", chart_type, cluster_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Hotspot endpoints
# ---------------------------------------------------------------------------

@app.get("/api/hotspots")
async def hotspots(min_samples: int = 20):
    """Return all detected violation hotspot clusters."""
    try:
        return cluster_engine.compute_hotspots(min_samples=min_samples)
    except Exception as exc:
        logger.exception("Hotspots endpoint error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/heatmap")
async def heatmap_data():
    """Return aggregated coordinates and month strings for the traffic violation heatmap."""
    try:
        return data_engine.get_heatmap_data()
    except Exception as exc:
        logger.exception("Heatmap endpoint error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/hotspots/trending")
async def trending_hotspots(min_samples: int = 20):
    """Return hotspot clusters with significant month-over-month growth."""
    try:
        return cluster_engine.get_trending_hotspots(min_samples=min_samples)
    except Exception as exc:
        logger.exception("Trending hotspots error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/hotspots/{cluster_id}")
async def hotspot_detail(cluster_id: int, min_samples: int = 20):
    """Return detailed information for a single hotspot cluster."""
    try:
        result = cluster_engine.get_hotspot_details(cluster_id, min_samples=min_samples)
        if "error" in result:
            raise HTTPException(status_code=404, detail=result["error"])
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Hotspot detail error for cluster %d: %s", cluster_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Additional data endpoints
# ---------------------------------------------------------------------------

@app.get("/api/data/stations")
async def list_stations():
    """Return list of all unique police stations and their total event counts."""
    try:
        return data_engine.get_violations_by_station(n=100)
    except Exception as exc:
        logger.exception("Stations list endpoint error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/data/stations/{station_name}")
async def station_details(station_name: str):
    """Return detailed event stats and monthly timeline for a single police station."""
    try:
        details = data_engine.get_station_details(station_name)
        if not details or details.get("total_violations") == 0:
            raise HTTPException(
                status_code=404,
                detail=f"Station '{station_name}' not found or has no events data."
            )
        return details
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Station details endpoint error for '%s': %s", station_name, exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/data/locations")
async def top_locations(n: int = 10):
    """Return top N locations by event count."""
    return data_engine.get_top_locations(n=n)


@app.get("/api/data/search")
async def search_violations(
    station: Optional[str] = None,
    violation_type: Optional[str] = None,
    vehicle_type: Optional[str] = None,
    limit: int = 100,
):
    """Search events with optional filters."""
    return data_engine.search_violations(
        station=station,
        violation_type=violation_type,
        vehicle_type=vehicle_type,
        limit=limit,
    )


@app.get("/api/data/vehicle_violation")
async def vehicle_for_violation(violation_type: str):
    """Return vehicle type distribution for a specific event cause."""
    return data_engine.get_vehicle_type_for_violation(violation_type)


@app.get("/api/data/compare_stations")
async def compare_stations(station_a: str, station_b: str):
    """Compare two police stations side by side."""
    return data_engine.compare_stations(station_a, station_b)


# ---------------------------------------------------------------------------
# Static files & SPA fallback
# ---------------------------------------------------------------------------
_frontend_dir = Path(__file__).resolve().parent.parent / "frontend"


@app.get("/")
async def serve_index():
    """Serve the frontend index.html at the root path."""
    index_path = _frontend_dir / "index.html"
    if index_path.exists():
        return FileResponse(str(index_path))
    return JSONResponse(
        {"message": "Frontend not found. API is running at /docs"},
        status_code=200,
    )


# Mount static files AFTER the API routes to avoid shadowing them.
if _frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(_frontend_dir)), name="frontend")
