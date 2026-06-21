import os
import pickle
import math
import osmium
import networkx as nx

# Bounding box of the dataset
MIN_LAT, MAX_LAT = 12.8010411, 13.2675104
MIN_LON, MAX_LON = 77.30873108, 77.76940255

def haversine_distance(lat1, lon1, lat2, lon2):
    """Calculate geodesic distance between two points in km."""
    R = 6371.0  # Earth radius in km
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2 + 
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2)
    c = 2 * math.asin(math.sqrt(a))
    return R * c

class RoadNetworkHandler(osmium.SimpleHandler):
    def __init__(self):
        super(RoadNetworkHandler, self).__init__()
        self.nodes = {}  # node_id -> (lat, lon)
        self.ways = []   # list of way dicts
        self.valid_highways = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary'}
        
        # Default speeds in km/h for Bangalore road types
        self.default_speeds = {
            'motorway': 80.0,
            'trunk': 60.0,
            'primary': 50.0,
            'secondary': 40.0,
            'tertiary': 30.0
        }
        
    def node(self, n):
        # Cache all node coordinates within the bounding box
        lat = n.location.lat
        lon = n.location.lon
        if MIN_LAT <= lat <= MAX_LAT and MIN_LON <= lon <= MAX_LON:
            self.nodes[n.id] = (lat, lon)
            
    def way(self, w):
        highway = w.tags.get('highway')
        if highway in self.valid_highways:
            way_id = w.id
            name = w.tags.get('name', f"Way {way_id}")
            oneway = w.tags.get('oneway', 'no') in ('yes', 'true', '1')
            
            # Speed limit parsing
            maxspeed_str = w.tags.get('maxspeed', '')
            try:
                maxspeed = float(''.join(filter(str.isdigit, maxspeed_str)))
            except ValueError:
                maxspeed = self.default_speeds.get(highway, 40.0)
                
            way_nodes = [node.ref for node in w.nodes]
            self.ways.append({
                'id': way_id,
                'nodes': way_nodes,
                'name': name,
                'highway': highway,
                'maxspeed': maxspeed,
                'oneway': oneway
            })

def build_road_network_graph(pbf_path, cache_path="data/road_network.gpickle"):
    """
    Parses the local OSM PBF file using osmium, constructs a NetworkX graph,
    and caches it as a pickle.
    """
    if os.path.exists(cache_path):
        print(f"Loading road network from cache: {cache_path}")
        with open(cache_path, 'rb') as f:
            return pickle.load(f)
            
    print(f"Parsing OSM PBF file: {pbf_path} ...")
    handler = RoadNetworkHandler()
    handler.apply_file(pbf_path, locations=True)
    
    G = nx.DiGraph()
    
    # Track nodes actually added to graph
    added_nodes = set()
    
    print(f"Constructing NetworkX graph from {len(handler.ways)} ways ...")
    for way in handler.ways:
        way_nodes = way['nodes']
        name = way['name']
        highway = way['highway']
        maxspeed = way['maxspeed']
        oneway = way['oneway']
        
        # Add edge segments
        for i in range(len(way_nodes) - 1):
            u_id = way_nodes[i]
            v_id = way_nodes[i+1]
            
            # Check if both nodes exist in our node list (i.e. within bounds)
            if u_id in handler.nodes and v_id in handler.nodes:
                lat_u, lon_u = handler.nodes[u_id]
                lat_v, lon_v = handler.nodes[v_id]
                
                dist_km = haversine_distance(lat_u, lon_u, lat_v, lon_v)
                # Avoid division by zero
                travel_time_mins = (dist_km / maxspeed) * 60.0 if maxspeed > 0 else 0.0
                
                # Add nodes with attributes
                if u_id not in added_nodes:
                    G.add_node(u_id, lat=lat_u, lon=lon_u)
                    added_nodes.add(u_id)
                if v_id not in added_nodes:
                    G.add_node(v_id, lat=lat_v, lon=lon_v)
                    added_nodes.add(v_id)
                    
                # Add forward edge
                G.add_edge(u_id, v_id, 
                           length_km=dist_km, 
                           maxspeed_kmh=maxspeed,
                           base_travel_time_mins=travel_time_mins,
                           current_travel_time_mins=travel_time_mins,
                           name=name,
                           highway=highway,
                           oneway=oneway)
                
                # Add backward edge if not a one-way street
                if not oneway:
                    G.add_edge(v_id, u_id, 
                               length_km=dist_km, 
                               maxspeed_kmh=maxspeed,
                               base_travel_time_mins=travel_time_mins,
                               current_travel_time_mins=travel_time_mins,
                               name=name,
                               highway=highway,
                               oneway=oneway)
                    
    print(f"Graph construction completed. Nodes: {G.number_of_nodes()}, Edges: {G.number_of_edges()}")
    
    # Save cache directory if not exists
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    with open(cache_path, 'wb') as f:
        pickle.dump(G, f)
        
    return G

if __name__ == "__main__":
    pbf = "data/planet_77.30873108,12.8010411_77.76940255,13.2675104.osm.pbf"
    build_road_network_graph(pbf)
