import os
import pandas as pd
import numpy as np
import json

# File paths resolved dynamically relative to the project root
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

RAW_DATA_PATH = os.path.join(PROJECT_ROOT, "data", "Astram_data.csv")
POST_EVENT_LOGS_PATH = os.path.join(PROJECT_ROOT, "data", "post_event_logs.csv")
MAPPINGS_PATH = os.path.join(PROJECT_ROOT, "data", "feature_mappings.json")
STATIONS_PATH = os.path.join(PROJECT_ROOT, "data", "police_stations.json")

def calculate_police_stations(df):
    """
    Computes coordinates for each police station by taking the centroid
    of historical incidents in its jurisdiction, and scales baseline resources
    based on historical incident density.
    """
    station_groups = df.groupby('police_station').agg(
        lat_mean=('latitude', 'mean'),
        lon_mean=('longitude', 'mean'),
        count=('id', 'count')
    ).reset_index()
    
    # Sort by count to identify density tiers
    station_groups = station_groups.sort_values(by='count', ascending=False)
    num_stations = len(station_groups)
    
    stations = {}
    for idx, row in station_groups.iterrows():
        name = row['police_station']
        lat = float(row['lat_mean'])
        lon = float(row['lon_mean'])
        count = int(row['count'])
        
        # Scale resources based on density percentiles (SOTA allocation logic)
        # Tier 1 (High Density): Top 15%
        # Tier 2 (Medium-High): 15% to 50%
        # Tier 3 (Medium-Low): 50% to 80%
        # Tier 4 (Low/Remote): Bottom 20%
        rank_pct = idx / num_stations
        
        if rank_pct <= 0.15:
            # High-density station
            officers, barricades, vehicles = 30, 40, 10
            tier = "Tier 1 (High Density)"
        elif rank_pct <= 0.50:
            officers, barricades, vehicles = 20, 25, 6
            tier = "Tier 2 (Medium-High)"
        elif rank_pct <= 0.80:
            officers, barricades, vehicles = 12, 15, 4
            tier = "Tier 3 (Medium-Low)"
        else:
            officers, barricades, vehicles = 5, 5, 2
            tier = "Tier 4 (Low Density)"
            
        stations[name] = {
            "name": name,
            "latitude": lat,
            "longitude": lon,
            "incident_count": count,
            "tier": tier,
            "total_officers": officers,
            "total_barricades": barricades,
            "total_vehicles": vehicles
        }
        
    with open(STATIONS_PATH, 'w') as f:
        json.dump(stations, f, indent=4)
        
    print(f"Saved {len(stations)} police stations coordinates and resource capacities to {STATIONS_PATH}")
    return stations

def load_and_clean_data(include_post_events=True):
    """
    Loads raw historical data, cleans timestamps, calculates target variables,
    normalizes to IST, and appends continuous learning post-event logs if they exist.
    """
    print("Loading historical raw dataset...")
    df = pd.read_csv(RAW_DATA_PATH)
    
    # Parse datetimes and convert UTC to IST
    datetime_cols = ['start_datetime', 'end_datetime', 'resolved_datetime', 'closed_datetime']
    for col in datetime_cols:
        if col in df.columns:
            df[col] = pd.to_datetime(df[col], errors='coerce')
            
    # Calculate duration by coalescing resolution fields (resolved -> closed -> end)
    dur_resolved = (df['resolved_datetime'] - df['start_datetime']).dt.total_seconds() / 60.0
    dur_closed = (df['closed_datetime'] - df['start_datetime']).dt.total_seconds() / 60.0
    dur_end = (df['end_datetime'] - df['start_datetime']).dt.total_seconds() / 60.0
    
    df['duration_mins'] = dur_resolved.fillna(dur_closed).fillna(dur_end)
    
    # Clean durations: positive and less than 12 hours (720 mins) to filter logging errors
    df = df[(df['duration_mins'] > 0) & (df['duration_mins'] <= 720.0)].copy()
    
    # Recalculate/Clean start timezone to local IST (+5:30)
    df['start_ist'] = df['start_datetime'] + pd.Timedelta(hours=5, minutes=30)
    
    # Calculate Severity Index
    priority_map = {'High': 2.0, 'Low': 1.0}
    df['priority_score'] = df['priority'].map(priority_map).fillna(1.0)
    df['closure_score'] = df['requires_road_closure'].map({True: 2.0, False: 1.0, 'TRUE': 2.0, 'FALSE': 1.0}).fillna(1.0)
    
    # Scale duration score 0 to 5
    max_dur = df['duration_mins'].max()
    df['duration_score'] = (df['duration_mins'] / max_dur) * 5.0
    df['severity_index'] = df['priority_score'] * df['closure_score'] + df['duration_score']
    
    # Average coordinates to build police stations
    calculate_police_stations(df)
    
    # Append continuous learning logs if requested
    if include_post_events and os.path.exists(POST_EVENT_LOGS_PATH):
        print(f"Loading continuous learning log files from {POST_EVENT_LOGS_PATH}...")
        try:
            post_df = pd.read_csv(POST_EVENT_LOGS_PATH)
            post_df['start_datetime'] = pd.to_datetime(post_df['start_datetime'], errors='coerce')
            post_df['start_ist'] = post_df['start_datetime'] + pd.Timedelta(hours=5, minutes=30)
            
            # Combine
            common_cols = ['event_type', 'event_cause', 'latitude', 'longitude', 
                           'requires_road_closure', 'priority', 'start_ist', 
                           'duration_mins', 'severity_index', 'police_station']
            
            # Extract common cols from raw and post
            df_subset = df[df_subset_cols := [c for c in common_cols if c in df.columns]].copy()
            post_subset = post_df[[c for c in common_cols if c in post_df.columns]].copy()
            
            df = pd.concat([df_subset, post_subset], ignore_index=True)
            print(f"Appended {len(post_subset)} rows from post-event logs. Total dataset size: {len(df)}")
        except Exception as e:
            print(f"Error loading continuous learning logs: {e}. Proceeding with historical data only.")
            
    return df

def generate_mappings(df):
    """
    Generates categorical mappings for event_type, event_cause, and police_station
    to ensure consistent label encoding.
    """
    mappings = {
        'event_type': {val: i for i, val in enumerate(df['event_type'].dropna().unique())},
        'event_cause': {val: i for i, val in enumerate(df['event_cause'].dropna().unique())},
        'police_station': {val: i for i, val in enumerate(df['police_station'].dropna().unique())}
    }
    
    # Save mappings
    with open(MAPPINGS_PATH, 'w') as f:
        json.dump(mappings, f, indent=4)
        
    print(f"Saved categorical mappings to {MAPPINGS_PATH}")
    return mappings

def engineer_features(df, mappings=None):
    """
    Extracts temporal and spatial features, and encodes categorical columns.
    """
    if mappings is None:
        if os.path.exists(MAPPINGS_PATH):
            with open(MAPPINGS_PATH, 'r') as f:
                mappings = json.load(f)
        else:
            mappings = generate_mappings(df)
            
    # Extract temporal features from start_ist
    df['start_ist'] = pd.to_datetime(df['start_ist'], errors='coerce')
    df['hour'] = df['start_ist'].dt.hour
    df['day_of_week'] = df['start_ist'].dt.dayofweek
    df['month'] = df['start_ist'].dt.month
    
    # Encode categories
    for col in ['event_type', 'event_cause', 'police_station']:
        mapping = mappings.get(col, {})
        # Map unknown categories to -1
        df[f'{col}_encoded'] = df[col].map(mapping).fillna(-1).astype(int)
        
    # Map priority and road closure
    df['priority_encoded'] = df['priority'].map({'High': 1, 'Low': 0}).fillna(0).astype(int)
    df['requires_road_closure_encoded'] = df['requires_road_closure'].map(
        {True: 1, False: 0, 'TRUE': 1, 'FALSE': 0}
    ).fillna(0).astype(int)
    
    return df

def get_train_features(df):
    """
    Selects the final training feature columns and targets.
    """
    feature_cols = [
        'latitude', 'longitude', 'hour', 'day_of_week', 'month',
        'event_type_encoded', 'event_cause_encoded', 'police_station_encoded',
        'priority_encoded', 'requires_road_closure_encoded'
    ]
    
    X = df[feature_cols].copy()
    y_duration = df['duration_mins'].copy()
    y_severity = df['severity_index'].copy()
    
    return X, y_duration, y_severity

if __name__ == "__main__":
    df = load_and_clean_data(include_post_events=False)
    mappings = generate_mappings(df)
    df = engineer_features(df, mappings)
    X, y_dur, y_sev = get_train_features(df)
    print(f"Features shape: {X.shape}, Duration target shape: {y_dur.shape}, Severity shape: {y_sev.shape}")
