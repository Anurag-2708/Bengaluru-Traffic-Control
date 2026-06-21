"""
data_engine.py — Data loading and aggregation engine for the Astram Event Co-Pilot.

Loads the Astram incident/event CSV, maps custom event fields to compatible structures,
and pre-computes event aggregations for fast query responses.
All public functions return plain Python dicts/lists (JSON-serializable).
"""

import ast
import json
import logging
import os
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd
# Try to load dotenv, otherwise read .env manually
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    env_path = Path(__file__).resolve().parent / ".env"
    if env_path.exists():
        with open(env_path, "r") as f:
            for line in f:
                if "=" in line and not line.strip().startswith("#"):
                    k, v = line.strip().split("=", 1)
                    os.environ[k.strip()] = v.strip()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
CSV_PATH = os.getenv("CSV_PATH", "../../Astram event data_anonymized - Astram event data_anonymizedb40ac87.csv")
# Resolve relative paths against this file's directory
_csv_resolved = (Path(__file__).resolve().parent / CSV_PATH).resolve()

logger = logging.getLogger("data_engine")
logging.basicConfig(level=logging.INFO)

# ---------------------------------------------------------------------------
# Parser for event cause to maintain list compatibility
# ---------------------------------------------------------------------------

def _parse_event_cause(value):
    """Wrap event cause string in a list to match Copilot 1's list representation."""
    if pd.isna(value) or value is None:
        return []
    val = str(value).strip()
    if not val or val.upper() in ["NULL", "NAN"]:
        return []
    return [val]


# ---------------------------------------------------------------------------
# Load and prepare the DataFrame
# ---------------------------------------------------------------------------
logger.info("Loading Astram CSV from: %s", _csv_resolved)

df_raw = pd.read_csv(str(_csv_resolved), low_memory=False)
logger.info("Loaded %d rows, %d columns", len(df_raw), len(df_raw.columns))

# Create our standard df with mapped columns
df = pd.DataFrame()

# Clean coordinates
df["latitude"] = pd.to_numeric(df_raw["latitude"], errors="coerce")
df["longitude"] = pd.to_numeric(df_raw["longitude"], errors="coerce")
df["id"] = df_raw["id"].fillna("").astype(str)

# Map Astram features
df["created_datetime"] = pd.to_datetime(df_raw["start_datetime"], errors="coerce", utc=True)
df["violation_type"] = df_raw["event_cause"].fillna("others").astype(str)
df["violation_type_list"] = df_raw["event_cause"].apply(_parse_event_cause)
df["vehicle_type"] = df_raw["veh_type"].fillna("others").astype(str)
df["vehicle_number"] = df_raw["veh_no"].fillna("unknown").astype(str)
df["police_station"] = df_raw["police_station"].fillna("No Police Station").astype(str)
df["location"] = df_raw["address"].fillna("unknown").astype(str)
df["junction_name"] = df_raw["junction"].fillna("No Junction").astype(str)

# Additional features specific to Astram event dataset
df["event_type"] = df_raw["event_type"].fillna("unplanned").astype(str)
df["priority"] = df_raw["priority"].fillna("Low").astype(str)
df["requires_road_closure"] = df_raw["requires_road_closure"].astype(str).str.upper().eq("TRUE")
df["status"] = df_raw["status"].fillna("closed").astype(str)
df["corridor"] = df_raw["corridor"].fillna("Non-corridor").astype(str)

# Drop any rows where datetime parsing failed
df = df.dropna(subset=["created_datetime"]).copy()

# Derived time columns
df["month"] = df["created_datetime"].dt.to_period("M").astype(str)
df["hour"] = df["created_datetime"].dt.hour
df["day_of_week"] = df["created_datetime"].dt.day_name()

# ---------------------------------------------------------------------------
# Pre-compute aggregations for performance
# ---------------------------------------------------------------------------

# Exploded event causes for cause-level statistics
_exploded = df.explode("violation_type_list").rename(
    columns={"violation_type_list": "vtype_single"}
)
_exploded = _exploded[_exploded["vtype_single"].notna() & (_exploded["vtype_single"] != "")]

# Event counts by cause
_vtype_counts = (
    _exploded["vtype_single"]
    .value_counts()
    .reset_index()
    .rename(columns={"index": "type", "vtype_single": "type", "count": "count"})
)

# Events by month
_month_counts = (
    df.groupby("month").size().reset_index(name="count").sort_values("month")
)

# Events by station
_station_counts = (
    df["police_station"]
    .value_counts()
    .reset_index()
    .rename(columns={"police_station": "station", "count": "count"})
)

# Events by vehicle type
_vehicle_counts = (
    df["vehicle_type"]
    .value_counts()
    .reset_index()
    .rename(columns={"vehicle_type": "vehicle_type", "count": "count"})
)

# Events by hour
_hour_counts = (
    df.groupby("hour").size().reset_index(name="count").sort_values("hour")
)

# Events by day of week (ordered Monday-Sunday)
_day_order = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
_dow_counts = (
    df.groupby("day_of_week").size().reset_index(name="count")
)
_dow_counts["day_of_week"] = pd.Categorical(
    _dow_counts["day_of_week"], categories=_day_order, ordered=True
)
_dow_counts = _dow_counts.sort_values("day_of_week")

# Date range
_min_date = df["created_datetime"].min()
_max_date = df["created_datetime"].max()

# Heatmap coordinate groupings pre-computation
_df_clean = df[
    df["latitude"].notna() & df["longitude"].notna()
    & (df["latitude"] != 0) & (df["longitude"] != 0)
].copy()
_df_clean["lat_r"] = _df_clean["latitude"].round(3)
_df_clean["lon_r"] = _df_clean["longitude"].round(3)
_heatmap_grouped = (
    _df_clean.groupby(["month", "lat_r", "lon_r"])
    .size()
    .reset_index(name="intensity")
    .rename(columns={"lat_r": "lat", "lon_r": "lon"})
)
_heatmap_data = _heatmap_grouped.to_dict(orient="records")

logger.info("Pre-computation complete.")


# ---------------------------------------------------------------------------
# Public API functions — all return JSON-serializable Python objects
# ---------------------------------------------------------------------------

def get_summary() -> dict:
    """Return a high-level summary of the entire dataset.

    Returns:
        dict with keys: total_violations, unique_vehicles, unique_stations,
        date_range, top_violation_types, top_stations, and Astram-specific counts.
    """
    top_types = _vtype_counts.head(5).to_dict(orient="records")
    top_stations = _station_counts.head(5).to_dict(orient="records")

    return {
        "total_violations": int(len(df)),
        "unique_vehicles": int(df["vehicle_number"].nunique()),
        "unique_stations": int(df["police_station"].nunique()),
        "date_range": {
            "start": str(_min_date) if pd.notna(_min_date) else None,
            "end": str(_max_date) if pd.notna(_max_date) else None,
        },
        "top_violation_types": top_types,
        "top_stations": top_stations,
        # Astram specifics:
        "event_type_distribution": df["event_type"].value_counts().to_dict(),
        "priority_distribution": df["priority"].value_counts().to_dict(),
        "requires_road_closure_count": int(df["requires_road_closure"].sum()),
        "active_events_count": int(df["status"].str.upper().eq("ACTIVE").sum())
    }


def get_violations_by_type() -> list:
    """Return event counts per cause type, sorted descending.

    Returns:
        List of dicts with keys: type, count.
    """
    return _vtype_counts.to_dict(orient="records")


def get_violations_by_month() -> list:
    """Return event counts per month (YYYY-MM), sorted chronologically.

    Returns:
        List of dicts with keys: month, count.
    """
    return _month_counts.to_dict(orient="records")


def get_violations_by_station(n: int = 10) -> list:
    """Return the top N police stations by event count.

    Args:
        n: Number of top stations to return (default 10).

    Returns:
        List of dicts with keys: station, count.
    """
    return _station_counts.head(n).to_dict(orient="records")


def get_violations_by_vehicle() -> list:
    """Return event counts per vehicle type, sorted descending.

    Returns:
        List of dicts with keys: vehicle_type, count.
    """
    return _vehicle_counts.to_dict(orient="records")


def get_violations_by_hour() -> list:
    """Return event counts per hour of day (0-23).

    Returns:
        List of dicts with keys: hour, count.
    """
    records = _hour_counts.to_dict(orient="records")
    for r in records:
        r["hour"] = int(r["hour"]) if pd.notna(r["hour"]) else r["hour"]
    return records


def get_violations_by_day_of_week() -> list:
    """Return event counts per day of week, Monday through Sunday.

    Returns:
        List of dicts with keys: day, count.
    """
    records = _dow_counts.to_dict(orient="records")
    return [{"day": r["day_of_week"], "count": int(r["count"])} for r in records]


def get_top_locations(n: int = 10) -> list:
    """Return top N locations by event count.

    Args:
        n: Number of top locations to return (default 10).

    Returns:
        List of dicts with keys: location, count.
    """
    loc_counts = (
        df["location"]
        .value_counts()
        .head(n)
        .reset_index()
        .rename(columns={"location": "location", "count": "count"})
    )
    return loc_counts.to_dict(orient="records")


def get_vehicle_type_for_violation(violation_type: str) -> list:
    """Return vehicle type distribution for a specific event cause.

    Args:
        violation_type: The event cause string to filter by (case-insensitive).

    Returns:
        List of dicts with keys: vehicle_type, count.
    """
    vt_upper = violation_type.strip().upper()
    mask = _exploded["vtype_single"].str.upper() == vt_upper
    subset = _exploded.loc[mask]
    if subset.empty:
        return []
    result = (
        subset["vehicle_type"]
        .value_counts()
        .reset_index()
        .rename(columns={"vehicle_type": "vehicle_type", "count": "count"})
    )
    return result.to_dict(orient="records")


def compare_stations(station_a: str, station_b: str) -> dict:
    """Compare event statistics between two police stations.

    Args:
        station_a: Name of the first police station.
        station_b: Name of the second police station.

    Returns:
        Dict with keys station_a and station_b, each containing:
        total_violations, top_violation_types, top_vehicle_types, peak_hour.
    """
    def _station_stats(station_name: str) -> dict:
        mask = df["police_station"].str.upper() == station_name.strip().upper()
        subset = df.loc[mask]
        if subset.empty:
            return {
                "station": station_name,
                "total_violations": 0,
                "top_violation_types": [],
                "top_vehicle_types": [],
                "peak_hour": None,
            }
        # Top event causes (exploded)
        ex_mask = _exploded["police_station"].str.upper() == station_name.strip().upper()
        ex_sub = _exploded.loc[ex_mask]
        top_vtypes = (
            ex_sub["vtype_single"]
            .value_counts()
            .head(5)
            .reset_index()
            .rename(columns={"vtype_single": "type", "count": "count"})
            .to_dict(orient="records")
        )
        # Top vehicle types
        top_vehicles = (
            subset["vehicle_type"]
            .value_counts()
            .head(5)
            .reset_index()
            .rename(columns={"vehicle_type": "vehicle_type", "count": "count"})
            .to_dict(orient="records")
        )
        # Peak hour
        hour_counts = subset["hour"].value_counts()
        peak = int(hour_counts.idxmax()) if not hour_counts.empty else None

        return {
            "station": station_name,
            "total_violations": int(len(subset)),
            "top_violation_types": top_vtypes,
            "top_vehicle_types": top_vehicles,
            "peak_hour": peak,
        }

    return {
        "station_a": _station_stats(station_a),
        "station_b": _station_stats(station_b),
    }


def get_station_details(station_name: str) -> dict:
    """Return detailed event statistics and a monthly timeline for a single police station.

    Args:
        station_name: Name of the police station.

    Returns:
        Dict with keys: station, total_violations, top_violation_types,
        top_vehicle_types, peak_hour, monthly_timeline.
    """
    mask = df["police_station"].str.upper() == station_name.strip().upper()
    subset = df.loc[mask]
    if subset.empty:
        return {
            "station": station_name,
            "total_violations": 0,
            "top_violation_types": [],
            "top_vehicle_types": [],
            "peak_hour": None,
            "monthly_timeline": {"labels": [], "values": []}
        }

    # Top event causes
    ex_mask = _exploded["police_station"].str.upper() == station_name.strip().upper()
    ex_sub = _exploded.loc[ex_mask]
    top_vtypes = (
        ex_sub["vtype_single"]
        .value_counts()
        .head(5)
        .reset_index()
        .rename(columns={"vtype_single": "type", "count": "count"})
        .to_dict(orient="records")
    )

    # Top vehicle types
    top_vehicles = (
        subset["vehicle_type"]
        .value_counts()
        .head(5)
        .reset_index()
        .rename(columns={"vehicle_type": "vehicle_type", "count": "count"})
        .to_dict(orient="records")
    )

    # Peak hour
    hour_counts = subset["hour"].value_counts()
    peak = int(hour_counts.idxmax()) if not hour_counts.empty else None

    # Monthly timeline
    monthly_counts = (
        subset.groupby("month").size().reset_index(name="count").sort_values("month")
    )
    timeline_labels = monthly_counts["month"].astype(str).tolist()
    timeline_values = monthly_counts["count"].tolist()

    return {
        "station": station_name,
        "total_violations": int(len(subset)),
        "top_violation_types": top_vtypes,
        "top_vehicle_types": top_vehicles,
        "peak_hour": peak,
        "monthly_timeline": {
            "labels": timeline_labels,
            "values": timeline_values
        }
    }


def search_violations(
    station: str = None,
    violation_type: str = None,
    vehicle_type: str = None,
    limit: int = 100,
) -> list:
    """Search and filter event records.

    Args:
        station: Filter by police station name (case-insensitive substring).
        violation_type: Filter by event cause (case-insensitive substring).
        vehicle_type: Filter by vehicle type (case-insensitive exact match).
        limit: Max number of records to return.

    Returns:
        List of event record dicts.
    """
    mask = pd.Series([True] * len(df), index=df.index)

    if station:
        mask &= df["police_station"].str.contains(station, case=False, na=False)
    if vehicle_type:
        mask &= df["vehicle_type"].str.upper() == vehicle_type.strip().upper()
    if violation_type:
        vt_upper = violation_type.strip().upper()
        mask &= df["violation_type_list"].apply(
            lambda lst: any(v.upper() == vt_upper for v in lst) if isinstance(lst, list) else False
        )

    subset = df.loc[mask].head(limit)

    # Select display columns and convert to records
    display_cols = [
        "id", "latitude", "longitude", "location", "vehicle_number",
        "vehicle_type", "violation_type", "police_station", "junction_name",
        "created_datetime", "event_type", "priority", "requires_road_closure",
        "status", "corridor"
    ]
    existing_cols = [c for c in display_cols if c in subset.columns]
    result = subset[existing_cols].copy()
    result["created_datetime"] = result["created_datetime"].astype(str)

    return result.to_dict(orient="records")


def get_data_sample(n: int = 100) -> list:
    """Return a random sample of rows for the data explorer.

    Args:
        n: Number of rows to sample.

    Returns:
        List of record dicts.
    """
    sample = df.sample(n=min(n, len(df)), random_state=42).copy()
    # Convert datetime columns to strings for JSON serialization
    for col in sample.select_dtypes(include=["datetime64[ns, UTC]", "datetime64[ns]"]).columns:
        sample[col] = sample[col].astype(str)
    # Drop the helper list column
    derived = {"violation_type_list", "month", "hour", "day_of_week"}
    sample = sample.drop(columns=[c for c in derived if c in sample.columns], errors="ignore")
    # Replace NaN with None for clean JSON
    sample = sample.where(pd.notna(sample), None)
    return sample.to_dict(orient="records")


def get_columns() -> list:
    """Return the list of column names in the dataset.

    Returns:
        List of column name strings.
    """
    # Return original columns, not derived ones
    derived = {"violation_type_list", "month", "hour", "day_of_week"}
    return [c for c in df.columns if c not in derived]


def get_heatmap_data() -> list:
    """Return the list of aggregated heatmap points: [{month, lat, lon, intensity}]."""
    return _heatmap_data
