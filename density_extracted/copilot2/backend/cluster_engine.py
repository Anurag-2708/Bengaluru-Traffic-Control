"""
cluster_engine.py — Spatial clustering engine for traffic incident hotspot detection.

Uses DBSCAN to cluster events by lat/lon coordinates, then computes
per-cluster statistics including dominant cause, vehicle type,
peak hour, and a composite priority score (0-100) leveraging Astram event features.

Results are cached after first computation for fast repeated access.
"""

import logging
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).resolve().parent))

import threading
from collections import Counter
from typing import Optional

import numpy as np
import pandas as pd
from sklearn.cluster import DBSCAN

logger = logging.getLogger("cluster_engine")

# ---------------------------------------------------------------------------
# Import the loaded DataFrame from data_engine
# ---------------------------------------------------------------------------
from data_engine import df as _df

# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------
_hotspot_cache: Optional[list] = None
_trending_cache: Optional[list] = None
_clustered_df: Optional[pd.DataFrame] = None
_last_min_samples: int = 20
_lock = threading.Lock()


def _build_hotspots(min_samples: int = 20) -> list:
    """Run DBSCAN clustering on lat/lon and compute per-cluster statistics.

    Returns:
        List of hotspot dicts, sorted by score descending.
    """
    # Drop rows with missing coordinates
    geo_df = _df.dropna(subset=["latitude", "longitude"]).copy()
    if geo_df.empty:
        logger.warning("No valid lat/lon rows found; returning empty hotspots.")
        return []

    coords = geo_df[["latitude", "longitude"]].values

    global _clustered_df
    # Run DBSCAN on the full dataset with dynamic min_samples
    db = DBSCAN(eps=0.001, min_samples=min_samples, metric="euclidean")
    labels_all = db.fit_predict(coords)

    geo_df["cluster"] = labels_all
    _clustered_df = geo_df

    # Discard noise (label == -1)
    clustered = geo_df[geo_df["cluster"] != -1]
    if clustered.empty:
        logger.warning("DBSCAN found no clusters; try lowering min_samples.")
        return []

    cluster_ids = sorted(clustered["cluster"].unique())

    # Max count for normalizing scores
    cluster_sizes = clustered.groupby("cluster").size()
    max_count = cluster_sizes.max() if not cluster_sizes.empty else 1

    hotspots = []
    for cid in cluster_ids:
        subset = clustered[clustered["cluster"] == cid]
        count = int(len(subset))

        # Centroid
        lat_center = float(subset["latitude"].mean())
        lon_center = float(subset["longitude"].mean())

        # Dominant event cause (from exploded lists)
        all_vtypes = []
        for vtl in subset["violation_type_list"]:
            if isinstance(vtl, list):
                all_vtypes.extend(vtl)
        vtype_counter = Counter(all_vtypes)
        dominant_vtype = vtype_counter.most_common(1)[0][0] if vtype_counter else "UNKNOWN"
        type_diversity = len(vtype_counter)

        # Dominant vehicle type
        veh_counter = Counter(subset["vehicle_type"].dropna())
        dominant_vehicle = veh_counter.most_common(1)[0][0] if veh_counter else "UNKNOWN"

        # Most common police station
        st_counter = Counter(subset["police_station"].dropna())
        station = st_counter.most_common(1)[0][0] if st_counter else "UNKNOWN"

        # Peak hour
        hour_counter = Counter(subset["hour"].dropna().astype(int))
        peak_hour = int(hour_counter.most_common(1)[0][0]) if hour_counter else 0

        # --- Composite score utilizing Astram specific features (0-100) ---
        # 50% frequency/count
        frequency_score = (count / max_count) * 50 if max_count > 0 else 0
        
        # 20% event cause diversity
        diversity_score = min(type_diversity / 8, 1.0) * 20
        
        # 15% priority score (proportion of High priority events)
        high_priority_count = int(subset["priority"].str.upper().eq("HIGH").sum())
        priority_ratio = high_priority_count / count if count > 0 else 0
        priority_score = priority_ratio * 15
        
        # 15% road closure score (proportion of events requiring road closure)
        road_closure_count = int(subset["requires_road_closure"].sum())
        road_closure_ratio = road_closure_count / count if count > 0 else 0
        road_closure_score = road_closure_ratio * 15

        score = min(round(frequency_score + diversity_score + priority_score + road_closure_score, 1), 100.0)

        # Label
        label = f"{station} – Area {cid}"

        hotspots.append({
            "cluster_id": int(cid),
            "lat": round(lat_center, 6),
            "lon": round(lon_center, 6),
            "violation_count": count,
            "dominant_violation_type": dominant_vtype,
            "dominant_vehicle_type": dominant_vehicle,
            "police_station": station,
            "peak_hour": peak_hour,
            "score": score,
            "label": label,
        })

    # Sort by score descending
    hotspots.sort(key=lambda h: h["score"], reverse=True)
    return hotspots


def compute_hotspots(min_samples: int = 20) -> list:
    """Return clustered hotspots (cached after first computation)."""
    global _hotspot_cache, _trending_cache, _clustered_df, _last_min_samples
    if _hotspot_cache is None or min_samples != _last_min_samples:
        with _lock:
            if _hotspot_cache is None or min_samples != _last_min_samples:
                logger.info("Computing hotspot clusters for min_samples=%d...", min_samples)
                if min_samples != _last_min_samples:
                    _hotspot_cache = None
                    _trending_cache = None
                    _clustered_df = None
                    _last_min_samples = min_samples
                _hotspot_cache = _build_hotspots(min_samples=min_samples)
                logger.info("Computed %d hotspot clusters.", len(_hotspot_cache))
    return _hotspot_cache


def get_trending_hotspots(threshold: float = 0.2, min_samples: int = 20) -> list:
    """Return clusters where month-over-month incident growth exceeds *threshold*."""
    global _trending_cache
    
    # Ensure hotspots are computed first
    hotspots = compute_hotspots(min_samples=min_samples)
    if _trending_cache is not None:
        return _trending_cache

    if not hotspots or _clustered_df is None:
        _trending_cache = []
        return _trending_cache

    clustered = _clustered_df[_clustered_df["cluster"] != -1].copy()

    if clustered.empty:
        _trending_cache = []
        return _trending_cache

    # Determine the last two months
    clustered["_month"] = clustered["created_datetime"].dt.to_period("M")
    months_sorted = sorted(clustered["_month"].dropna().unique())
    if len(months_sorted) < 2:
        _trending_cache = []
        return _trending_cache

    current_month = months_sorted[-1]
    previous_month = months_sorted[-2]

    cur = clustered[clustered["_month"] == current_month]
    prev = clustered[clustered["_month"] == previous_month]

    cur_counts = cur.groupby("cluster").size()
    prev_counts = prev.groupby("cluster").size()

    # Build a lookup from hotspot list
    hs_lookup = {h["cluster_id"]: h for h in hotspots}

    trending = []
    for cid in cur_counts.index:
        c_count = int(cur_counts[cid])
        p_count = int(prev_counts.get(cid, 0))
        if p_count == 0:
            growth = float("inf") if c_count > 0 else 0.0
        else:
            growth = (c_count - p_count) / p_count

        if growth > threshold:
            hs = hs_lookup.get(int(cid), {})
            trending.append({
                "cluster_id": int(cid),
                "label": hs.get("label", f"Cluster {cid}"),
                "lat": hs.get("lat", 0.0),
                "lon": hs.get("lon", 0.0),
                "current_month_count": c_count,
                "previous_month_count": p_count,
                "growth_rate": round(growth, 4) if growth != float("inf") else 999.0,
            })

    trending.sort(key=lambda t: t["growth_rate"], reverse=True)
    _trending_cache = trending
    return _trending_cache


def get_hotspot_details(cluster_id: int, min_samples: int = 20) -> dict:
    """Return detailed information for a single hotspot cluster."""
    hotspots = compute_hotspots(min_samples=min_samples)
    for h in hotspots:
        if h["cluster_id"] == cluster_id:
            return h
    return {"error": f"Cluster {cluster_id} not found."}


def get_cluster_chart(cluster_id: int, chart_type: str, min_samples: int = 20) -> dict:
    """Compute chart statistics dynamically for a specific cluster."""
    global _clustered_df
    # Ensure hotspots are computed so _clustered_df is populated
    compute_hotspots(min_samples=min_samples)
    if _clustered_df is None:
        return {"labels": [], "values": []}

    cluster_df = _clustered_df[_clustered_df["cluster"] == cluster_id]
    if cluster_df.empty:
        return {"labels": [], "values": []}

    if chart_type == "violations_by_type":
        exploded = cluster_df.explode("violation_type_list")
        exploded = exploded[exploded["violation_type_list"].notna() & (exploded["violation_type_list"] != "")]
        counts = exploded["violation_type_list"].value_counts().head(10)
        return {"labels": [str(x) for x in counts.index], "values": [int(x) for x in counts.values]}

    elif chart_type == "violations_by_month":
        counts = cluster_df.groupby("month").size().sort_index()
        return {"labels": [str(x) for x in counts.index], "values": [int(x) for x in counts.values]}

    elif chart_type == "violations_by_station":
        counts = cluster_df["police_station"].value_counts().head(10)
        return {"labels": [str(x) for x in counts.index], "values": [int(x) for x in counts.values]}

    elif chart_type == "violations_by_vehicle":
        counts = cluster_df["vehicle_type"].value_counts()
        return {"labels": [str(x) for x in counts.index], "values": [int(x) for x in counts.values]}

    elif chart_type == "violations_by_hour":
        counts = cluster_df.groupby("hour").size()
        hours = list(range(24))
        values = [int(counts.get(h, 0)) for h in hours]
        return {"labels": [f"{h:02d}:00" for h in hours], "values": values}

    elif chart_type == "violations_by_day_of_week":
        counts = cluster_df.groupby("day_of_week").size()
        day_order = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        values = [int(counts.get(d, 0)) for d in day_order]
        return {"labels": day_order, "values": values}

    return {"labels": [], "values": []}
