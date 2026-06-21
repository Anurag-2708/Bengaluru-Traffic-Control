import os
import json
import pickle
import pandas as pd
import numpy as np
from datetime import datetime
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, BackgroundTasks, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from src.data_pipeline import engineer_features, load_and_clean_data, MAPPINGS_PATH, STATIONS_PATH, POST_EVENT_LOGS_PATH
from src.solvers import AllocationSolver, RoutingSolver, GeminiRecommender
from src.osm_parser import haversine_distance
from src.train_models import train_and_save_models

app = FastAPI(title="GridAI Emergency Response API", version="1.0.0")

origins_env = os.environ.get("CORS_ORIGINS")
origins = [o.strip() for o in origins_env.split(",")] if origins_env else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global variables for models and data
models = {}
mappings = {}
stations = {}
active_events = {}
routing_solver = None
gemini_recommender = GeminiRecommender()

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ACTIVE_EVENTS_PATH = os.path.join(PROJECT_ROOT, "data", "active_events.json")

@app.on_event("startup")
def startup_event():
    global routing_solver, mappings, stations, active_events
    
    # Load models
    model_paths = {
        "lgb_dur": os.path.join(PROJECT_ROOT, "models", "lgb_dur.pkl"),
        "xgb_dur": os.path.join(PROJECT_ROOT, "models", "xgb_dur.pkl"),
        "lgb_sev": os.path.join(PROJECT_ROOT, "models", "lgb_sev.pkl"),
        "xgb_sev": os.path.join(PROJECT_ROOT, "models", "xgb_sev.pkl"),
    }
    for name, path in model_paths.items():
        if os.path.exists(path):
            with open(path, "rb") as f:
                models[name] = pickle.load(f)
        else:
            print(f"Warning: Model file {path} not found.")
            
    # Load mappings
    if os.path.exists(MAPPINGS_PATH):
        with open(MAPPINGS_PATH, "r") as f:
            mappings.update(json.load(f))
            
    # Load stations
    if os.path.exists(STATIONS_PATH):
        with open(STATIONS_PATH, "r") as f:
            stations.update(json.load(f))
            
    # Initialize station resource availabilities/deployed counts if not present
    for s_name, s_info in stations.items():
        if "available_officers" not in s_info:
            s_info["available_officers"] = s_info.get("total_officers", 10)
        if "deployed_officers" not in s_info:
            s_info["deployed_officers"] = 0
        if "available_barricades" not in s_info:
            s_info["available_barricades"] = s_info.get("total_barricades", 10)
        if "deployed_barricades" not in s_info:
            s_info["deployed_barricades"] = 0
        if "available_vehicles" not in s_info:
            s_info["available_vehicles"] = s_info.get("total_vehicles", 2)
        if "deployed_vehicles" not in s_info:
            s_info["deployed_vehicles"] = 0

    # Load active events
    if os.path.exists(ACTIVE_EVENTS_PATH):
        try:
            with open(ACTIVE_EVENTS_PATH, "r") as f:
                active_events.update(json.load(f))
        except Exception as e:
            print(f"Error loading active events: {e}")
            active_events.clear()
            
    # Load routing graph
    routing_solver = RoutingSolver()


# Request/Response Schemas

class PredictRequest(BaseModel):
    event_type: str = Field(..., example="planned")
    event_cause: str = Field(..., example="procession")
    latitude: float = Field(..., example=12.97883)
    longitude: float = Field(..., example=77.59953)
    requires_road_closure: bool = Field(..., example=True)
    priority: str = Field(..., example="High")
    start_datetime_ist: str = Field(..., example="2026-06-20T17:00:00")

class PredictResponse(BaseModel):
    predicted_duration_mins: float
    predicted_severity_index: float
    predicted_congestion_level: str
    predicted_impact_radius_km: float
    closest_station_name: str
    predicted_response_time_mins: float
    recommendations: Optional[Dict[str, Any]] = None

class IncidentAllocItem(BaseModel):
    id: str
    latitude: float
    longitude: float
    severity_index: float
    requires_road_closure: bool

class StationAllocItem(BaseModel):
    name: str
    latitude: float
    longitude: float
    available_officers: int
    available_barricades: int
    available_vehicles: int

class AllocateRequest(BaseModel):
    incidents: List[IncidentAllocItem]
    stations: List[StationAllocItem]

class DivertRequest(BaseModel):
    origin_lat: float
    origin_lon: float
    destination_lat: float
    destination_lon: float
    incident_lat: float
    incident_lon: float
    requires_road_closure: bool
    severity_index: float

class StationUpdatePayload(BaseModel):
    name: str
    total_officers: int
    total_barricades: int
    total_vehicles: int

class DeployEventPayload(BaseModel):
    id: str
    event_type: str
    event_cause: str
    latitude: float
    longitude: float
    priority: str
    requires_road_closure: bool
    severity_index: float
    duration_mins: float
    congestion_level: str
    impact_radius_km: float
    response_time_mins: float
    dispatches: List[Dict[str, Any]]
    alternative_paths: Optional[List[Dict[str, Any]]] = None
    start_datetime_ist: str

class CloseEventPayload(BaseModel):
    id: str
    actual_duration_mins: float
    actual_severity_index: float
    actual_congestion: str
    actual_impact_radius_km: float
    actual_response_time_mins: float
    additional_officers_requested: int = 0
    additional_barricades_requested: int = 0
    additional_vehicles_requested: int = 0
    manual_operator_adjustments: str = "None"

class ReassessEventPayload(BaseModel):
    id: str

class FeedbackRequest(BaseModel):
    event_type: str
    event_cause: str
    latitude: float
    longitude: float
    requires_road_closure: bool
    priority: str
    start_datetime_ist: str
    actual_duration_mins: float
    actual_severity_index: float
    police_station: str


# Endpoints

@app.post("/predict", response_model=PredictResponse)
def predict(payload: PredictRequest):
    if not models:
        raise HTTPException(status_code=500, detail="Prediction models are not loaded.")
        
    try:
        # Find closest station
        closest_station = "Unknown"
        min_dist = float('inf')
        for name, info in stations.items():
            dist = haversine_distance(payload.latitude, payload.longitude, info['latitude'], info['longitude'])
            if dist < min_dist:
                min_dist = dist
                closest_station = name
                
        # Parse datetime
        dt = datetime.fromisoformat(payload.start_datetime_ist)
        
        # Prepare feature DataFrame
        input_data = pd.DataFrame([{
            'latitude': payload.latitude,
            'longitude': payload.longitude,
            'event_type': payload.event_type,
            'event_cause': payload.event_cause,
            'police_station': closest_station,
            'priority': payload.priority,
            'requires_road_closure': payload.requires_road_closure,
            'start_ist': dt
        }])
        
        # Feature Engineering
        engineered_df = engineer_features(input_data, mappings)
        
        feature_cols = [
            'latitude', 'longitude', 'hour', 'day_of_week', 'month',
            'event_type_encoded', 'event_cause_encoded', 'police_station_encoded',
            'priority_encoded', 'requires_road_closure_encoded'
        ]
        
        X = engineered_df[feature_cols]
        
        # Run Ensemble Inference (Average LGBM & XGBoost)
        pred_lgb_dur = models["lgb_dur"].predict(X)[0]
        pred_xgb_dur = models["xgb_dur"].predict(X)[0]
        duration = float((pred_lgb_dur + pred_xgb_dur) / 2.0)
        
        pred_lgb_sev = models["lgb_sev"].predict(X)[0]
        pred_xgb_sev = models["xgb_sev"].predict(X)[0]
        severity = float((pred_lgb_sev + pred_xgb_sev) / 2.0)
        
        # Post-process outputs
        severity = max(0.0, min(10.0, severity))
        duration = max(1.0, duration)
        
        # Derived fields
        impact_radius = float(0.2 * severity)
        
        if severity >= 7.0:
            congestion = "Congested"
        elif severity >= 4.0:
            congestion = "Moderate"
        else:
            congestion = "Low"
            
        # Estimate response time based on nearest station distance and congestion
        # Base speed 30km/h, response time = 8 mins + travel time
        travel_time = (min_dist / 30.0) * 60.0
        response_time = float(8.0 + travel_time * (1.0 + 0.1 * severity))
        
        # 5. LLM recommendation recommendations using GeminiRecommender
        try:
            recommender = GeminiRecommender()
            rec_plan = recommender.generate(payload.dict(), {
                "predicted_duration_mins": round(duration, 2),
                "predicted_severity_index": round(severity, 2),
                "predicted_congestion_level": congestion,
                "predicted_impact_radius_km": round(impact_radius, 2),
                "predicted_response_time_mins": round(response_time, 2)
            })
        except Exception:
            rec_plan = {
                "resource_recommendations": "Deploy patrol vehicle and officers.",
                "officer_allocation": "Station officers to manage boundaries.",
                "barricade_placement": "Set up barricades at nearest crossing.",
                "risk_mitigation_strategies": "Reroute local traffic to alternative lanes."
            }

        return PredictResponse(
            predicted_duration_mins=round(duration, 2),
            predicted_severity_index=round(severity, 2),
            predicted_congestion_level=congestion,
            predicted_impact_radius_km=round(impact_radius, 2),
            predicted_response_time_mins=round(response_time, 2),
            closest_station_name=closest_station,
            recommendations=rec_plan
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Prediction error: {str(e)}")

@app.post("/allocate")
def allocate(payload: AllocateRequest):
    try:
        incidents_list = [
            {
                'id': inc.id,
                'latitude': inc.latitude,
                'longitude': inc.longitude,
                'severity_index': inc.severity_index,
                'requires_road_closure': inc.requires_road_closure
            } for inc in payload.incidents
        ]
        
        stations_dict = {
            stat.name: {
                'name': stat.name,
                'latitude': stat.latitude,
                'longitude': stat.longitude,
                'available_officers': stat.available_officers,
                'available_barricades': stat.available_barricades,
                'available_vehicles': stat.available_vehicles
            } for stat in payload.stations
        }
        
        res = AllocationSolver.solve(incidents_list, stations_dict)
        return res
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Allocation optimization error: {str(e)}")

@app.post("/divert")
def divert(payload: DivertRequest):
    if not routing_solver:
        raise HTTPException(status_code=500, detail="Routing graph solver not initialized.")
        
    try:
        res = routing_solver.get_diversion_routes(
            incident_lat=payload.incident_lat,
            incident_lon=payload.incident_lon,
            requires_road_closure=payload.requires_road_closure,
            severity_index=payload.severity_index,
            origin_lat=payload.origin_lat,
            origin_lon=payload.origin_lon,
            destination_lat=payload.destination_lat,
            destination_lon=payload.destination_lon
        )
        return res
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Diversion routing error: {str(e)}")

def run_background_retrain():
    print("Starting background continuous learning model retrain...")
    try:
        # Retrain and update models on disk
        metrics = train_and_save_models(include_post_events=True)
        # Reload models
        startup_event()
        print("Continuous learning retraining completed successfully.")
    except Exception as e:
        print(f"Error during background retraining: {e}")

@app.post("/feedback")
def feedback(payload: FeedbackRequest, background_tasks: BackgroundTasks):
    try:
        # Construct CSV row
        new_row = {
            'event_type': payload.event_type,
            'event_cause': payload.event_cause,
            'latitude': payload.latitude,
            'longitude': payload.longitude,
            'requires_road_closure': payload.requires_road_closure,
            'priority': payload.priority,
            'start_datetime': payload.start_datetime_ist,
            'duration_mins': payload.actual_duration_mins,
            'severity_index': payload.actual_severity_index,
            'police_station': payload.police_station
        }
        
        # Write to post_event_logs.csv
        df = pd.DataFrame([new_row])
        if os.path.exists(POST_EVENT_LOGS_PATH):
            df.to_csv(POST_EVENT_LOGS_PATH, mode='a', header=False, index=False)
        else:
            df.to_csv(POST_EVENT_LOGS_PATH, mode='w', header=True, index=False)
            
        # Trigger background retraining
        background_tasks.add_task(run_background_retrain)
        
        return {"status": "success", "message": "Feedback logged. Retraining triggered in background."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Feedback logging error: {str(e)}")

@app.get("/mappings")
def get_mappings():
    return mappings

@app.get("/feature_importance")
def get_feature_importance():
    path = os.path.join(PROJECT_ROOT, "data", "feature_importance.json")
    if os.path.exists(path):
        with open(path, "r") as f:
            return json.load(f)
    return {}

@app.get("/historical_events")
def get_historical_events():
    path = os.path.join(PROJECT_ROOT, "data", "Astram_data.csv")
    if os.path.exists(path):
        try:
            df = pd.read_csv(path)
            df_cleaned = df.dropna(subset=['latitude', 'longitude'])
            # Sample up to 500 rows for rendering performance
            sample = df_cleaned.sample(min(len(df_cleaned), 500), random_state=42)
            sample = sample.where(pd.notna(sample), None)
            return sample.to_dict(orient="records")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to read historical data: {str(e)}")
    return []

from density_extracted.copilot2.backend.data_engine import get_heatmap_data as get_density_heatmap_data

@app.get("/api/heatmap")
def get_heatmap():
    try:
        return get_density_heatmap_data()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load density heatmap data: {str(e)}")

from density_extracted.copilot2.backend.cluster_engine import compute_hotspots as get_density_hotspots, get_trending_hotspots as get_density_trending_hotspots

@app.get("/api/hotspots")
def get_hotspots(min_samples: int = 20):
    try:
        return get_density_hotspots(min_samples=min_samples)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load hotspots: {str(e)}")

@app.get("/api/hotspots/trending")
def get_trending_hotspots_endpoint(min_samples: int = 20):
    try:
        return get_density_trending_hotspots(min_samples=min_samples)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load trending hotspots: {str(e)}")

@app.post("/retrain")
def trigger_retrain(background_tasks: BackgroundTasks):
    background_tasks.add_task(run_background_retrain)
    return {"status": "success", "message": "Retraining started in background."}

@app.get("/stations")
def get_stations():
    return stations

@app.post("/stations/update")
def update_station(payload: StationUpdatePayload):
    if payload.name not in stations:
        raise HTTPException(status_code=404, detail="Station not found")
    
    stat = stations[payload.name]
    stat["total_officers"] = payload.total_officers
    stat["total_barricades"] = payload.total_barricades
    stat["total_vehicles"] = payload.total_vehicles
    
    # Recalculate available resources
    stat["available_officers"] = max(0, stat["total_officers"] - stat.get("deployed_officers", 0))
    stat["available_barricades"] = max(0, stat["total_barricades"] - stat.get("deployed_barricades", 0))
    stat["available_vehicles"] = max(0, stat["total_vehicles"] - stat.get("deployed_vehicles", 0))
    
    # Save to disk
    with open(STATIONS_PATH, "w") as f:
        json.dump(stations, f, indent=4)
        
    return stat

@app.get("/events")
def get_events():
    return active_events

@app.post("/events/deploy")
def deploy_event(payload: DeployEventPayload):
    # Add to active events
    active_events[payload.id] = payload.dict()
    active_events[payload.id]["deployed_at"] = datetime.now().isoformat()
    active_events[payload.id]["status"] = "Live Event"
    
    # Deduct resources
    for disp in payload.dispatches:
        name = disp["station_name"]
        if name in stations:
            stations[name]["available_officers"] = max(0, stations[name]["available_officers"] - disp.get("officers", 0))
            stations[name]["deployed_officers"] = stations[name].get("deployed_officers", 0) + disp.get("officers", 0)
            
            stations[name]["available_barricades"] = max(0, stations[name]["available_barricades"] - disp.get("barricades", 0))
            stations[name]["deployed_barricades"] = stations[name].get("deployed_barricades", 0) + disp.get("barricades", 0)
            
            stations[name]["available_vehicles"] = max(0, stations[name]["available_vehicles"] - disp.get("vehicles", 0))
            stations[name]["deployed_vehicles"] = stations[name].get("deployed_vehicles", 0) + disp.get("vehicles", 0)
            
    # Save to disk
    with open(STATIONS_PATH, "w") as f:
        json.dump(stations, f, indent=4)
    with open(ACTIVE_EVENTS_PATH, "w") as f:
        json.dump(active_events, f, indent=4)
        
    return active_events[payload.id]

@app.post("/events/close")
def close_event(payload: CloseEventPayload):
    if payload.id not in active_events:
        raise HTTPException(status_code=404, detail="Event not found")
        
    event = active_events.pop(payload.id)
    
    # Release resources
    for disp in event.get("dispatches", []):
        name = disp["station_name"]
        if name in stations:
            stations[name]["available_officers"] = min(stations[name]["total_officers"], stations[name]["available_officers"] + disp.get("officers", 0))
            stations[name]["deployed_officers"] = max(0, stations[name]["deployed_officers"] - disp.get("officers", 0))
            
            stations[name]["available_barricades"] = min(stations[name]["total_barricades"], stations[name]["available_barricades"] + disp.get("barricades", 0))
            stations[name]["deployed_barricades"] = max(0, stations[name]["deployed_barricades"] - disp.get("barricades", 0))
            
            stations[name]["available_vehicles"] = min(stations[name]["total_vehicles"], stations[name]["available_vehicles"] + disp.get("vehicles", 0))
            stations[name]["deployed_vehicles"] = max(0, stations[name]["deployed_vehicles"] - disp.get("vehicles", 0))
            
    # Save active_events and stations
    with open(STATIONS_PATH, "w") as f:
        json.dump(stations, f, indent=4)
    with open(ACTIVE_EVENTS_PATH, "w") as f:
        json.dump(active_events, f, indent=4)
        
    # Find closest police station name
    closest_station = event.get("closest_station_name", "Unknown")
    if closest_station == "Unknown":
        min_dist = float('inf')
        for name, info in stations.items():
            dist = haversine_distance(event['latitude'], event['longitude'], info['latitude'], info['longitude'])
            if dist < min_dist:
                min_dist = dist
                closest_station = name
 
    # Write detailed metrics to post_event_logs.csv
    tot_officers_alloc = sum(disp.get("officers", 0) for disp in event.get("dispatches", []))
    tot_barricades_alloc = sum(disp.get("barricades", 0) for disp in event.get("dispatches", []))
    tot_vehicles_alloc = sum(disp.get("vehicles", 0) for disp in event.get("dispatches", []))
    
    new_row = {
        'event_type': event['event_type'],
        'event_cause': event['event_cause'],
        'latitude': event['latitude'],
        'longitude': event['longitude'],
        'requires_road_closure': event['requires_road_closure'],
        'priority': event['priority'],
        'start_datetime': event['start_datetime_ist'],
        'duration_mins': payload.actual_duration_mins,
        'severity_index': payload.actual_severity_index,
        'police_station': closest_station
    }
    
    df = pd.DataFrame([new_row])
    # Add optional extra columns that don't disrupt training
    df['event_id'] = event['id']
    df['predicted_duration_mins'] = event.get('duration_mins', 0.0)
    df['predicted_severity_index'] = event.get('severity_index', 0.0)
    df['actual_congestion'] = payload.actual_congestion
    df['predicted_congestion'] = event.get('congestion_level', 'Low')
    df['actual_impact_radius_km'] = payload.actual_impact_radius_km
    df['predicted_impact_radius_km'] = event.get('impact_radius_km', 0.0)
    df['actual_response_time_mins'] = payload.actual_response_time_mins
    df['predicted_response_time_mins'] = event.get('response_time_mins', 0.0)
    df['officers_allocated'] = tot_officers_alloc
    df['barricades_allocated'] = tot_barricades_alloc
    df['vehicles_allocated'] = tot_vehicles_alloc
    df['additional_officers_requested'] = payload.additional_officers_requested
    df['additional_barricades_requested'] = payload.additional_barricades_requested
    df['additional_vehicles_requested'] = payload.additional_vehicles_requested
    df['manual_operator_adjustments'] = payload.manual_operator_adjustments
    
    if os.path.exists(POST_EVENT_LOGS_PATH):
        try:
            existing_df = pd.read_csv(POST_EVENT_LOGS_PATH)
            combined_df = pd.concat([existing_df, df], ignore_index=True)
            combined_df.to_csv(POST_EVENT_LOGS_PATH, index=False)
        except Exception:
            df.to_csv(POST_EVENT_LOGS_PATH, index=False)
    else:
        df.to_csv(POST_EVENT_LOGS_PATH, index=False)
        
    return {"status": "success", "message": "Event closed, resources released, outcomes logged. Model retraining postponed."}

@app.post("/events/reassess")
def reassess_event(payload: ReassessEventPayload):
    if payload.id not in active_events:
        raise HTTPException(status_code=404, detail="Event not found")
        
    event = active_events[payload.id]
    
    event_details = {
        "event_cause": event.get("event_cause"),
        "priority": event.get("priority"),
        "requires_road_closure": event.get("requires_road_closure")
    }
    
    model_predictions = {
        "predicted_severity_index": event.get("severity_index"),
        "predicted_duration_mins": event.get("duration_mins")
    }
    
    prompt_modifier = "\nNote: This event is currently OVERDUE. The current active time has exceeded the predicted resolution time. Please reassess the deployment and recommend any additional resources or adjustments required."
    
    rec = gemini_recommender.generate(event_details, model_predictions, overdue_note=prompt_modifier)
    return rec

@app.get("/archives")
def get_archives():
    if os.path.exists(POST_EVENT_LOGS_PATH):
        try:
            df = pd.read_csv(POST_EVENT_LOGS_PATH)
            records = df.to_dict(orient="records")
            cleaned_records = []
            for r in records:
                cleaned_r = {}
                for k, v in r.items():
                    if isinstance(v, float) and (np.isnan(v) or np.isinf(v)):
                        cleaned_r[k] = None
                    elif pd.isna(v):
                        cleaned_r[k] = None
                    else:
                        cleaned_r[k] = v
                cleaned_records.append(cleaned_r)
            return cleaned_records
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to read post event logs: {str(e)}")
    return []

@app.get("/model_metrics")
def get_model_metrics():
    path = os.path.join(PROJECT_ROOT, "data", "model_metrics.json")
    if os.path.exists(path):
        with open(path, "r") as f:
            return json.load(f)
    return {}

@app.get("/response_card_options")
def get_response_card_options():
    path = os.path.join(PROJECT_ROOT, "data", "Astram_data.csv")
    if not os.path.exists(path):
        return {"corridors": [], "time_slots": ["Morning Rush (8-12 AM)", "Afternoon (12-4 PM)", "Evening Rush (4-9 PM)", "Night (9 PM-8 AM)"]}
    try:
        df = pd.read_csv(path, usecols=['corridor', 'event_cause'])
        corridors = sorted(df['corridor'].dropna().unique().tolist())
        causes = sorted(df['event_cause'].dropna().unique().tolist())
        return {
            "corridors": corridors[:50],  # top 50 unique corridors
            "event_causes": causes,
            "time_slots": ["Morning Rush (8-12 AM)", "Afternoon (12-4 PM)", "Evening Rush (4-9 PM)", "Night (9 PM-8 AM)"]
        }
    except Exception as e:
        return {"corridors": [], "event_causes": [], "time_slots": []}

@app.get("/response_card")
def get_response_card(
    event_cause: str,
    corridor: Optional[str] = None,
    time_of_day: Optional[str] = None,
    latitude: Optional[float] = None,
    longitude: Optional[float] = None
):
    path = os.path.join(PROJECT_ROOT, "data", "Astram_data.csv")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Astram dataset not found.")
        
    try:
        df = pd.read_csv(path)
        
        # Clean durations and dates
        df['start_datetime'] = pd.to_datetime(df['start_datetime'], errors='coerce')
        df['resolved_datetime'] = pd.to_datetime(df['resolved_datetime'], errors='coerce')
        df['closed_datetime'] = pd.to_datetime(df['closed_datetime'], errors='coerce')
        df['end_datetime'] = pd.to_datetime(df['end_datetime'], errors='coerce')
        
        dur_resolved = (df['resolved_datetime'] - df['start_datetime']).dt.total_seconds() / 60.0
        dur_closed = (df['closed_datetime'] - df['start_datetime']).dt.total_seconds() / 60.0
        dur_end = (df['end_datetime'] - df['start_datetime']).dt.total_seconds() / 60.0
        
        df['duration_mins'] = dur_resolved.fillna(dur_closed).fillna(dur_end)
        df['duration_mins'] = df['duration_mins'].fillna(45.0)
        df.loc[df['duration_mins'] <= 0, 'duration_mins'] = 45.0
        
        # Determine time of day label
        df['start_hour'] = df['start_datetime'].dt.hour
        def get_tod(hour):
            if pd.isna(hour):
                return "Evening Rush (4-9 PM)"
            if 8 <= hour < 12:
                return "Morning Rush (8-12 AM)"
            elif 12 <= hour < 16:
                return "Afternoon (12-4 PM)"
            elif 16 <= hour < 21:
                return "Evening Rush (4-9 PM)"
            else:
                return "Night (9 PM-8 AM)"
        df['time_of_day'] = df['start_hour'].apply(get_tod)
        
        # Matching process
        match_type = "Exact Match"
        
        # Match cause, corridor, and time of day
        cause_mask = df['event_cause'].str.lower() == event_cause.lower()
        
        # If corridor is not passed but coords are, look up nearest police station and match by it or look up nearest corridor
        if (not corridor or corridor.strip() == "") and latitude is not None and longitude is not None:
            # find closest station name
            closest_station = "Unknown"
            min_dist = float('inf')
            for name, info in stations.items():
                dist = haversine_distance(latitude, longitude, info['latitude'], info['longitude'])
                if dist < min_dist:
                    min_dist = dist
                    closest_station = name
            corridor_mask = df['police_station'].str.lower() == closest_station.lower()
            corridor = closest_station
        else:
            corridor_mask = df['corridor'].str.lower() == (corridor or '').lower()
            
        tod_mask = df['time_of_day'] == (time_of_day or "Evening Rush (4-9 PM)")
        
        match = df[cause_mask & corridor_mask & tod_mask]
        
        if len(match) < 3:
            match = df[cause_mask & corridor_mask]
            match_type = "Corridor/Station Match"
            
        if len(match) < 3:
            match = df[cause_mask]
            match_type = "Cause Match"
            
        def format_mins(mins):
            if mins is None or pd.isna(mins):
                return "—"
            h = int(mins // 60)
            m = int(mins % 60)
            if h > 0:
                return f"{h}h {m}m"
            return f"{m}m"
            
        similar_count = len(match)
        if similar_count > 0:
            median_dur = float(match['duration_mins'].median())
            p25 = float(match['duration_mins'].quantile(0.25))
            p75 = float(match['duration_mins'].quantile(0.75))
            
            closure_mask = match['requires_road_closure'].astype(str).str.upper().isin(['TRUE', 'YES', '1'])
            closure_rate = float(closure_mask.mean() * 100)
            
            top_stations = match['police_station'].dropna().value_counts().head(3).index.tolist()
            
            # Common vehicle types
            veh_counts = match['veh_type'].dropna().value_counts().head(4)
            common_vehicles = [{"type": str(k), "count": int(v)} for k, v in veh_counts.items()]
            
            # Zone
            zone_val = "Unknown"
            if 'zone' in match.columns:
                zone_counts = match['zone'].dropna().value_counts()
                if not zone_counts.empty:
                    zone_val = str(zone_counts.index[0])
                    
            # Diversion corridors
            all_corridors = match['corridor'].dropna().value_counts().head(4).index.tolist()
            div_corridors = [c for c in all_corridors if c.lower() != (corridor or '').lower()][:3]
            if not div_corridors:
                div_corridors = all_corridors[:3]
                
            # Similar past events list
            past_df = match.sort_values(by='start_datetime', ascending=False).head(5)
            similar_events = []
            for _, row in past_df.iterrows():
                dt_str = "—"
                if not pd.isna(row['start_datetime']):
                    dt_str = row['start_datetime'].strftime('%Y-%m-%d')
                similar_events.append({
                    "date": dt_str,
                    "duration": format_mins(row['duration_mins']),
                    "station": str(row['police_station']) if not pd.isna(row['police_station']) else "—",
                    "description": str(row['description']) if not pd.isna(row['description']) and str(row['description']).strip() != '' else "—"
                })
        else:
            median_dur = 45.0
            p25 = 30.0
            p75 = 60.0
            closure_rate = 0.0
            top_stations = []
            common_vehicles = []
            zone_val = "Unknown"
            div_corridors = []
            similar_events = []
            
        return {
            "match_type": match_type,
            "similar_events_found": similar_count,
            "median_resolution_time": format_mins(median_dur),
            "resolution_range": f"{format_mins(p25)} — {format_mins(p75)}",
            "road_closure_rate": f"{closure_rate:.1f}%",
            "nearest_stations": top_stations,
            "common_vehicle_types": common_vehicles,
            "zone": zone_val,
            "diversion_corridors": div_corridors,
            "similar_past_events": similar_events
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate response card: {str(e)}")

