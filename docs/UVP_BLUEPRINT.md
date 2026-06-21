# GridAI Mathematical Blueprint & Contract Specification

This blueprint documents the mathematical models, routing algorithms, infrastructure capacities, and API schemas that form the core of the GridAI platform.

---

## 1. Mathematical Formulations

### 1.1 Density-Based Police Station Resource Allocation
Rather than uniform resources, each of the $|J| = 54$ police stations is assigned baseline resource capacities scaled by the local density of historical events in `data/Astram_data.csv`. 

Let $N_j$ be the number of historical incidents occurring closest (geodesic distance) to police station $j$. We partition stations into four tiers:
- **Tier 1 (High Density)**: Top 15% of stations by event count.
  - Officers: 30, Barricades: 40, Patrol Vehicles: 10
- **Tier 2 (Medium-High Density)**: 15% - 50% percentile.
  - Officers: 20, Barricades: 25, Patrol Vehicles: 6
- **Tier 3 (Medium-Low Density)**: 50% - 80% percentile.
  - Officers: 12, Barricades: 15, Patrol Vehicles: 4
- **Tier 4 (Low Density/Remote)**: Bottom 20% of stations.
  - Officers: 5, Barricades: 5, Patrol Vehicles: 2

---

### 1.2 Resource Allocation Optimization Model (PuLP MILP)
When a set of active incidents $I$ is deployed, we solve a Mixed-Integer Linear Program (MILP) to determine the optimal resource dispatch from stations $J$ to incidents $I$.

#### Sets & Indices:
- $I$: Set of active incidents, indexed by $i$.
- $J$: Set of police stations, indexed by $j$.

#### Parameters:
- $S_i \in [0, 10]$: Predicted severity of incident $i$.
- $R_i \in \{0, 1\}$: Binary closure status of incident $i$ ($1$ if road closure is required).
- $p_i^{req} = \lceil 1 + 1.5 \cdot S_i \rceil$: Officer demand for incident $i$.
- $b_i^{req} = \lceil 3.0 \cdot S_i \cdot R_i \rceil$: Barricade demand for incident $i$.
- $v_i^{req} = \lceil 0.5 \cdot S_i \rceil$: Patrol vehicle demand for incident $i$.
- $P_j^{avail}, B_j^{avail}, V_j^{avail}$: Available officers, barricades, and patrol vehicles currently at station $j$.
- $d_{ij}$: Geodesic distance (Haversine) from station $j$ to incident $i$ (in km).

#### Decision Variables:
- $p_{ij} \in \mathbb{Z}^+$: Number of officers dispatched from station $j$ to incident $i$.
- $b_{ij} \in \mathbb{Z}^+$: Number of barricades dispatched from station $j$ to incident $i$.
- $v_{ij} \in \mathbb{Z}^+$: Number of patrol vehicles dispatched from station $j$ to incident $i$.
- $y_{ij} \in \{0, 1\}$: Binary variable indicating if station $j$ is selected to deploy to incident $i$.
- $u_i^p, u_i^b, u_i^v \ge 0$: Auxiliary variables representing unmet demands for officers, barricades, and vehicles.

#### Objective Function:
Minimize transit workload and penalize unmet demands:
$$\text{Minimize } \sum_{i \in I} \sum_{j \in J} \left( 10.0 \cdot d_{ij} \cdot y_{ij} + 1.0 \cdot d_{ij} \cdot (p_{ij} + b_{ij} + v_{ij}) \right) + \sum_{i \in I} \left( 1000.0 \cdot u_i^p + 500.0 \cdot u_i^b + 800.0 \cdot u_i^v \right)$$

#### Constraints:
1. **Supply Limits**:
   $$\sum_{i \in I} p_{ij} \le P_j^{avail} \quad \forall j \in J$$
   $$\sum_{i \in I} b_{ij} \le B_j^{avail} \quad \forall j \in J$$
   $$\sum_{i \in I} v_{ij} \le V_j^{avail} \quad \forall j \in J$$
2. **Unmet Demands**:
   $$u_i^p \ge p_i^{req} - \sum_{j \in J} p_{ij} \quad \forall i \in I$$
   $$u_i^b \ge b_i^{req} - \sum_{j \in J} b_{ij} \quad \forall i \in I$$
   $$u_i^v \ge v_i^{req} - \sum_{j \in J} v_{ij} \quad \forall i \in I$$
3. **Activation Enforcement (Big-M)**:
   $$p_{ij} + b_{ij} + v_{ij} \le 100 \cdot y_{ij} \quad \forall i \in I, \forall j \in J$$

---

### 1.3 Road Network Routing & Diversion (NetworkX)
The road network is represented as a directed graph $G = (V, E)$. 
Nodes $V$ represent OSM intersections. Edges $E$ represent road segments.

Each edge $e = (u, v) \in E$ has:
- `length`: Geodesic distance (in meters).
- `maxspeed`: Speed limit (in km/h).
- `base_travel_time`: $\tau_e^0 = \text{length} / \text{maxspeed}$ (in minutes).
- `current_travel_time`: $\tau_e$.

#### Congestion Propagation:
An active incident $i$ at coordinates $(lat_i, lon_i)$ propagates congestion to nearby edges within its predicted impact radius $R_i^{impact}$ (in km). For any edge $e$ within this radius:
- Let $d(e, i)$ be the distance from the midpoint of edge $e$ to the incident.
- If $d(e, i) \le R_i^{impact}$, the travel time is scaled:
  $$\tau_e = \tau_e^0 \cdot \left( 1 + \theta \cdot S_i \cdot \left(1 - \frac{d(e, i)}{R_i^{impact}}\right) \right)$$
  where $\theta = 0.5$ is a congestion multiplier.
- If $R_i = 1$ (road closure required), the nearest edge in the graph is completely blocked ($\tau_e = \infty$ or removed from routing).

#### Diversion:
Using Yen's $k$-shortest paths algorithm on the updated travel times, the system computes the top $k = 3$ paths bypassing the blocked/congested edges, offering alternative routing guidance.

---

## 2. API Contract Specification (JSON Schema)

### 2.1 `/predict` (Ensemble ML Prediction)
#### Request (POST):
```json
{
  "event_type": "planned",
  "event_cause": "procession",
  "latitude": 12.97883,
  "longitude": 77.59953,
  "requires_road_closure": true,
  "priority": "High",
  "start_datetime_ist": "2026-06-20T17:00:00"
}
```

#### Response:
```json
{
  "predicted_duration_mins": 145.2,
  "predicted_severity_index": 7.3,
  "predicted_congestion_level": "Congested",
  "predicted_impact_radius_km": 1.8,
  "predicted_response_time_mins": 18.5
}
```

---

### 2.2 `/allocate` (PuLP MILP Optimization)
#### Request (POST):
```json
{
  "incidents": [
    {
      "id": "SIM_001",
      "latitude": 12.97883,
      "longitude": 77.59953,
      "severity_index": 7.3,
      "requires_road_closure": true
    }
  ],
  "stations": [
    {
      "name": "Halasuru Gate",
      "latitude": 12.9723,
      "longitude": 77.5932,
      "available_officers": 20,
      "available_barricades": 25,
      "available_vehicles": 6
    }
  ]
}
```

#### Response:
```json
{
  "allocations": [
    {
      "incident_id": "SIM_001",
      "dispatches": [
        {
          "station_name": "Halasuru Gate",
          "officers": 12,
          "barricades": 22,
          "vehicles": 4,
          "transit_distance_km": 0.98
        }
      ],
      "unmet_officers": 0,
      "unmet_barricades": 0,
      "unmet_vehicles": 0
    }
  ]
}
```

---

### 2.3 `/divert` (Routing diversion)
#### Request (POST):
```json
{
  "origin_lat": 12.9654,
  "origin_lon": 77.5921,
  "destination_lat": 12.9852,
  "destination_lon": 77.6081,
  "incident_lat": 12.97883,
  "incident_lon": 77.59953,
  "requires_road_closure": true,
  "severity_index": 7.3
}
```

#### Response:
```json
{
  "alternative_paths": [
    {
      "path_index": 0,
      "coords": [[12.9654, 77.5921], [12.9701, 77.5945], [12.9852, 77.6081]],
      "travel_time_mins": 8.4,
      "distance_km": 2.3
    }
  ]
}
```
