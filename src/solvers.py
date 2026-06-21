import os
import json
import math
import pickle
import pulp
import networkx as nx
import google.generativeai as genai
from src.osm_parser import haversine_distance

GEMINI_CACHE_PATH = "data/gemini_cache.json"

class AllocationSolver:
    @staticmethod
    def solve(incidents, stations):
        """
        Solves the MILP resource allocation model using PuLP.
        incidents: list of dicts: [{'id': str, 'latitude': float, 'longitude': float, 'severity_index': float, 'requires_road_closure': bool}]
        stations: dict: {station_name: {name, latitude, longitude, available_officers, available_barricades, available_vehicles}}
        """
        if not incidents or not stations:
            return {"allocations": []}
            
        prob = pulp.LpProblem("Resource_Allocation", pulp.LpMinimize)
        
        incident_ids = [inc['id'] for inc in incidents]
        station_names = list(stations.keys())
        
        # Decision Variables
        p_vars = pulp.LpVariable.dicts("p", ((i, j) for i in incident_ids for j in station_names), lowBound=0, cat='Integer')
        b_vars = pulp.LpVariable.dicts("b", ((i, j) for i in incident_ids for j in station_names), lowBound=0, cat='Integer')
        v_vars = pulp.LpVariable.dicts("v", ((i, j) for i in incident_ids for j in station_names), lowBound=0, cat='Integer')
        y_vars = pulp.LpVariable.dicts("y", ((i, j) for i in incident_ids for j in station_names), cat='Binary')
        
        unmet_p = pulp.LpVariable.dicts("unmet_p", incident_ids, lowBound=0)
        unmet_b = pulp.LpVariable.dicts("unmet_b", incident_ids, lowBound=0)
        unmet_v = pulp.LpVariable.dicts("unmet_v", incident_ids, lowBound=0)
        
        # Demands & Distances calculations
        demands = {}
        distances = {}
        for inc in incidents:
            i_id = inc['id']
            sev = inc['severity_index']
            closure = inc['requires_road_closure']
            
            # Formulations from UVP_BLUEPRINT
            p_req = int(math.ceil(1.0 + 1.5 * sev))
            b_req = int(math.ceil(3.0 * sev * (1.0 if closure else 0.0)))
            v_req = int(math.ceil(0.5 * sev))
            
            demands[i_id] = {'p': p_req, 'b': b_req, 'v': v_req}
            
            distances[i_id] = {}
            for s_name, stat in stations.items():
                dist = haversine_distance(stat['latitude'], stat['longitude'], inc['latitude'], inc['longitude'])
                distances[i_id][s_name] = dist
                
        # Constraints
        # 1. Supply limits per station
        for j in station_names:
            stat = stations[j]
            prob += pulp.lpSum([p_vars[(i, j)] for i in incident_ids]) <= stat.get('available_officers', 0), f"Supply_Officers_{j}"
            prob += pulp.lpSum([b_vars[(i, j)] for i in incident_ids]) <= stat.get('available_barricades', 0), f"Supply_Barricades_{j}"
            prob += pulp.lpSum([v_vars[(i, j)] for i in incident_ids]) <= stat.get('available_vehicles', 0), f"Supply_Vehicles_{j}"
            
        # 2. Unmet demands definitions
        for i in incident_ids:
            prob += unmet_p[i] >= demands[i]['p'] - pulp.lpSum([p_vars[(i, j)] for j in station_names]), f"Unmet_P_Def_{i}"
            prob += unmet_b[i] >= demands[i]['b'] - pulp.lpSum([b_vars[(i, j)] for j in station_names]), f"Unmet_B_Def_{i}"
            prob += unmet_v[i] >= demands[i]['v'] - pulp.lpSum([v_vars[(i, j)] for j in station_names]), f"Unmet_V_Def_{i}"
            
        # 3. Activation constraints (Big-M)
        for i in incident_ids:
            for j in station_names:
                prob += p_vars[(i, j)] + b_vars[(i, j)] + v_vars[(i, j)] <= 100 * y_vars[(i, j)], f"Activation_{i}_{j}"
                
        # Objective Function
        # Minimize travel costs + severe penalties for unmet demands
        travel_cost = pulp.lpSum([
            10.0 * distances[i][j] * y_vars[(i, j)] + 
            1.0 * distances[i][j] * (p_vars[(i, j)] + b_vars[(i, j)] + v_vars[(i, j)])
            for i in incident_ids for j in station_names
        ])
        unmet_penalty = pulp.lpSum([
            1000.0 * unmet_p[i] + 500.0 * unmet_b[i] + 800.0 * unmet_v[i]
            for i in incident_ids
        ])
        prob += travel_cost + unmet_penalty, "Total_Objective"
        
        # Solve
        prob.solve(pulp.PULP_CBC_CMD(msg=False))
        
        # Build allocations output
        results = []
        for inc in incidents:
            i_id = inc['id']
            dispatches = []
            for j in station_names:
                p_val = int(p_vars[(i_id, j)].varValue or 0)
                b_val = int(b_vars[(i_id, j)].varValue or 0)
                v_val = int(v_vars[(i_id, j)].varValue or 0)
                
                if p_val > 0 or b_val > 0 or v_val > 0:
                    dispatches.append({
                        "station_name": j,
                        "officers": p_val,
                        "barricades": b_val,
                        "vehicles": v_val,
                        "transit_distance_km": float(round(distances[i_id][j], 2))
                    })
            results.append({
                "incident_id": i_id,
                "dispatches": dispatches,
                "unmet_officers": int(unmet_p[i_id].varValue or 0),
                "unmet_barricades": int(unmet_b[i_id].varValue or 0),
                "unmet_vehicles": int(unmet_v[i_id].varValue or 0)
            })
            
        return {"allocations": results}

class RoutingSolver:
    def __init__(self, cache_path="data/road_network.gpickle"):
        self.cache_path = cache_path
        self.G = None
        self.load_graph()
        
    def load_graph(self):
        if os.path.exists(self.cache_path):
            with open(self.cache_path, 'rb') as f:
                self.G = pickle.load(f)
                
    def find_nearest_node(self, lat, lon):
        if self.G is None:
            return None, float('inf')
        best_node = None
        best_dist = float('inf')
        for node, data in self.G.nodes(data=True):
            d = haversine_distance(lat, lon, data['lat'], data['lon'])
            if d < best_dist:
                best_dist = d
                best_node = node
        return best_node, best_dist

    def get_diversion_routes(self, incident_lat, incident_lon, requires_road_closure, severity_index,
                             origin_lat=None, origin_lon=None, destination_lat=None, destination_lon=None, path_count=3):
        """
        Calculates alternative routes that bypass the incident location.
        """
        if self.G is None:
            return {"alternative_paths": []}
            
        # Find nearest node to incident
        inc_node, inc_dist = self.find_nearest_node(incident_lat, incident_lon)
        if not inc_node or inc_dist > 5.0: # If too far, assume no impact on this network
            return {"alternative_paths": []}
            
        # Determine source (origin) node
        if origin_lat is not None and origin_lon is not None:
            source, _ = self.find_nearest_node(origin_lat, origin_lon)
        else:
            preds = list(self.G.predecessors(inc_node))
            source = preds[0] if preds else None
            
        # Determine target (destination) node
        if destination_lat is not None and destination_lon is not None:
            target, _ = self.find_nearest_node(destination_lat, destination_lon)
        else:
            succs = list(self.G.successors(inc_node))
            target = succs[0] if succs else None
            
        if not source or not target:
            return {"alternative_paths": []}
        
        # Clone graph to apply temporary weights/removals
        G_temp = self.G.copy()
        
        # Apply congestion propagation or closure
        impact_radius_km = float(0.2 * severity_index)
        
        # Calculate midpoints and scale travel times
        for u, v, data in G_temp.edges(data=True):
            u_lat, u_lon = G_temp.nodes[u]['lat'], G_temp.nodes[u]['lon']
            v_lat, v_lon = G_temp.nodes[v]['lat'], G_temp.nodes[v]['lon']
            mid_lat = (u_lat + v_lat) / 2
            mid_lon = (u_lon + v_lon) / 2
            
            d = haversine_distance(mid_lat, mid_lon, incident_lat, incident_lon)
            if d <= impact_radius_km:
                if requires_road_closure and (u == inc_node or v == inc_node):
                    # Closed road
                    G_temp[u][v]['current_travel_time_mins'] = 999999.0
                else:
                    # Congested road scale
                    scale = 1.0 + 0.5 * severity_index * (1.0 - d / impact_radius_km)
                    G_temp[u][v]['current_travel_time_mins'] = data['base_travel_time_mins'] * scale
                    
        # Compute alternative paths using shortest_simple_paths
        alternative_paths = []
        try:
            generator = nx.shortest_simple_paths(G_temp, source, target, weight='current_travel_time_mins')
            count = 0
            for path in generator:
                if count >= path_count:
                    break
                    
                # Format path coordinates
                coords = [[self.G.nodes[n]['lat'], self.G.nodes[n]['lon']] for n in path]
                
                # Compute path metrics
                total_dist = 0.0
                total_time = 0.0
                for idx in range(len(path) - 1):
                    u_n, v_n = path[idx], path[idx+1]
                    total_dist += G_temp[u_n][v_n]['length_km']
                    total_time += G_temp[u_n][v_n]['current_travel_time_mins']
                    
                alternative_paths.append({
                    "path_index": count,
                    "coords": coords,
                    "travel_time_mins": float(round(total_time, 2)),
                    "distance_km": float(round(total_dist, 2))
                })
                count += 1
        except nx.NetworkXNoPath:
            pass
            
        return {"alternative_paths": alternative_paths}

class GeminiRecommender:
    def __init__(self):
        self.cache = self.load_cache()
        self.model = None
        self.api_initialized = False
        
    def load_cache(self):
        if os.path.exists(GEMINI_CACHE_PATH):
            try:
                with open(GEMINI_CACHE_PATH, 'r') as f:
                    return json.load(f)
            except Exception:
                return {}
        return {}
        
    def save_cache(self):
        os.makedirs(os.path.dirname(GEMINI_CACHE_PATH), exist_ok=True)
        with open(GEMINI_CACHE_PATH, 'w') as f:
            json.dump(self.cache, f, indent=4)
            
    def get_fallback_recommendations(self, event_cause, severity_index, requires_road_closure, priority):
        """
        Rule-based generator to provide realistic mock structured outputs if Gemini API key fails or is missing.
        """
        severity_label = "Severe" if severity_index >= 6.5 else ("Moderate" if severity_index >= 4.5 else "Low")
        
        officers_str = f"Deploy 3-6 personnel for traffic control."
        barricades_str = "No barricades required."
        vehicles_str = "Deploy 1 patrol vehicle to roam the perimeter."
        rerouting_str = "Monitor flows, no major diversions needed."
        closure_str = "Keep all lanes open. Divert minor breakdown vehicles to the shoulder."
        
        if requires_road_closure:
            officers_str = "Deploy 8-10 officers: 2 at incident node, 4 at upstream diversion points, 2 at downstream merge gates."
            barricades_str = "Place 15-20 heavy barricades. Set up a physical barrier 200 meters upstream of the closure."
            vehicles_str = "Station 2 patrol units: 1 with flashing lights upstream of the block, 1 monitoring the detour route."
            rerouting_str = "Divert all incoming traffic from the main corridor onto secondary alternative pathways."
            closure_str = "Complete road closure active. Block all lanes to vehicles. Allow emergency services only."
            
        elif event_cause == "water_logging":
            officers_str = "Deploy 4-6 officers with high-visibility gear to guide vehicles around deep water pockets."
            barricades_str = "Place 5-10 barricades to partition flooded lanes."
            vehicles_str = "Station 1 vehicle with water-extraction coordinator."
            rerouting_str = "Reroute heavy trucks to elevated bypasses. Keep small cars on high ground."
            closure_str = "Partial lane closure. Keep at least one lane open. Slow down speed limits to 20 km/h."
            
        elif event_cause == "public_event" or event_cause == "procession":
            officers_str = "Deploy crowd control squad (12-15 personnel) along the procession pathway."
            barricades_str = "Place 30-40 barricades along the sidewalk to keep pedestrians isolated from traffic lanes."
            vehicles_str = "Station 2 patrol vehicles at the tail of the crowd."
            rerouting_str = "Divert bus traffic away from the high-pedestrian corridor."
            closure_str = "Rolling closure of lanes as the procession moves. Keep parallel roads clear."
            
        return {
            "resource_recommendations": f"Allocate emergency units to handle the {severity_label} traffic breakdown caused by {event_cause}.",
            "officer_allocation": officers_str,
            "barricade_placement": barricades_str,
            "patrol_allocation": vehicles_str,
            "traffic_rerouting_plan": rerouting_str,
            "road_closure_recommendation": closure_str,
            "risk_mitigation_strategies": f"Establish constant radio contact. Set up flashing lights. Coordinate with BBMP/Towing services immediately."
        }

    def generate(self, event_details, model_predictions, api_key=None, overdue_note=""):
        """
        Generates structured deployment recommendations using Gemini or the rule-based fallback.
        """
        # Create a unique cache key incorporating location and time to avoid cross-event caching
        lat = event_details.get('latitude', 0.0)
        lon = event_details.get('longitude', 0.0)
        time_str = event_details.get('start_datetime_ist', '')
        cache_key = f"{event_details.get('event_cause')}_{event_details.get('requires_road_closure')}_{model_predictions.get('predicted_severity_index')}_{event_details.get('priority')}_{lat}_{lon}_{time_str}"
        if overdue_note:
            cache_key += "_overdue"
            
        if cache_key in self.cache:
            print("Gemini response retrieved from cache.")
            return self.cache[cache_key]
            
        # Try to use API if key is provided or in environment
        key = api_key or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        
        if not key:
            print("No Gemini API key found. Falling back to rule-based recommendations.")
            fallback = self.get_fallback_recommendations(
                event_details.get('event_cause'),
                model_predictions.get('predicted_severity_index', 3.0),
                event_details.get('requires_road_closure'),
                event_details.get('priority')
            )
            if overdue_note:
                fallback["resource_recommendations"] = "[OVERDUE REASSESSMENT] " + fallback["resource_recommendations"] + " (Additional support recommended)"
                fallback["risk_mitigation_strategies"] = "Re-coordinated active perimeter patrols. " + fallback["risk_mitigation_strategies"]
            return fallback
            
        try:
            if not self.api_initialized:
                genai.configure(api_key=key)
                self.model = genai.GenerativeModel('gemini-2.5-flash')
                self.api_initialized = True
                
            prompt = f"""
            You are a senior traffic coordinator and operations researcher in Bangalore, India.
            Based on the following traffic incident predictions, generate structured, actionable dispatch and routing recommendations:
            
            Incident Details:
            - Cause: {event_details.get('event_cause')}
            - Priority: {event_details.get('priority')}
            - Road Closure Required: {event_details.get('requires_road_closure')}
            
            Ensemble Model Predictions:
            - Severity Index: {model_predictions.get('predicted_severity_index')} / 10.0
            - Predicted Duration: {model_predictions.get('predicted_duration_mins')} minutes
            
            Available Resources details:
            - Dispatched police stations, personnel capacities, barricades, and patrol vehicles.
            {overdue_note}
            
            Please provide your response strictly in the following JSON format:
            {{
              "resource_recommendations": "string summarizing general resource guidelines",
              "officer_allocation": "string detailing exact officer postings at diversion/incident nodes",
              "barricade_placement": "string explaining how many barricades to place and where",
              "patrol_allocation": "string explaining patrol vehicle locations and speeds",
              "traffic_rerouting_plan": "string outlining clear alternative detour streets",
              "road_closure_recommendation": "string describing partial or full closure protocols",
              "risk_mitigation_strategies": "string outlining crowd controls and emergency coordination"
            }}
            Return ONLY the raw JSON string, without any markdown formatting or prefix.
            """
            
            response = self.model.generate_content(prompt)
            text = response.text.strip()
            
            # Clean possible markdown wrap ```json ... ```
            if text.startswith("```json"):
                text = text[7:]
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()
            
            recommendations = json.loads(text)
            
            # Save cache
            self.cache[cache_key] = recommendations
            self.save_cache()
            return recommendations
            
        except Exception as e:
            print(f"Gemini API error ({e}). Falling back to rule-based recommendations.")
            fallback = self.get_fallback_recommendations(
                event_details.get('event_cause'),
                model_predictions.get('predicted_severity_index', 3.0),
                event_details.get('requires_road_closure'),
                event_details.get('priority')
            )
            if overdue_note:
                fallback["resource_recommendations"] = "[OVERDUE REASSESSMENT] " + fallback["resource_recommendations"] + " (Additional support recommended)"
                fallback["risk_mitigation_strategies"] = "Re-coordinated active perimeter patrols. " + fallback["risk_mitigation_strategies"]
            return fallback

