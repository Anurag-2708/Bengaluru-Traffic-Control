import json
import unittest
from fastapi.testclient import TestClient
from src.main import app, startup_event

class TestGridAIAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        startup_event()
        cls.client = TestClient(app)

    def test_predict_endpoint(self):
        payload = {
            "event_type": "planned",
            "event_cause": "procession",
            "latitude": 12.97883,
            "longitude": 77.59953,
            "requires_road_closure": True,
            "priority": "High",
            "start_datetime_ist": "2026-06-20T17:00:00"
        }
        response = self.client.post("/predict", json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("predicted_duration_mins", data)
        self.assertIn("predicted_severity_index", data)
        self.assertIn("predicted_congestion_level", data)
        self.assertIn("predicted_impact_radius_km", data)
        self.assertIn("predicted_response_time_mins", data)
        self.assertIsInstance(data["predicted_duration_mins"], float)
        self.assertIsInstance(data["predicted_severity_index"], float)

    def test_allocate_endpoint(self):
        payload = {
            "incidents": [
                {
                    "id": "TEST_INC_001",
                    "latitude": 12.97883,
                    "longitude": 77.59953,
                    "severity_index": 7.3,
                    "requires_road_closure": True
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
        response = self.client.post("/allocate", json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("allocations", data)
        allocations = data["allocations"]
        self.assertGreater(len(allocations), 0)
        self.assertEqual(allocations[0]["incident_id"], "TEST_INC_001")
        self.assertIn("dispatches", allocations[0])

    def test_divert_endpoint(self):
        payload = {
            "origin_lat": 12.9654,
            "origin_lon": 77.5921,
            "destination_lat": 12.9852,
            "destination_lon": 77.6081,
            "incident_lat": 12.97883,
            "incident_lon": 77.59953,
            "requires_road_closure": True,
            "severity_index": 7.3
        }
        response = self.client.post("/divert", json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("alternative_paths", data)
        self.assertIsInstance(data["alternative_paths"], list)

    def test_feedback_endpoint(self):
        payload = {
            "event_type": "planned",
            "event_cause": "procession",
            "latitude": 12.97883,
            "longitude": 77.59953,
            "requires_road_closure": True,
            "priority": "High",
            "start_datetime_ist": "2026-06-20T17:00:00",
            "actual_duration_mins": 140.0,
            "actual_severity_index": 6.8,
            "police_station": "Halasuru Gate"
        }
        response = self.client.post("/feedback", json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "success")

    def test_get_stations(self):
        response = self.client.get("/stations")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIsInstance(data, dict)
        self.assertGreater(len(data), 0)

    def test_update_station(self):
        payload = {
            "name": "Halasuru Gate",
            "total_officers": 35,
            "total_barricades": 45,
            "total_vehicles": 12
        }
        response = self.client.post("/stations/update", json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["total_officers"], 35)
        self.assertEqual(data["available_officers"], 35 - data.get("deployed_officers", 0))

    def test_deploy_close_and_reassess(self):
        # 1. Deploy Event
        deploy_payload = {
            "id": "TEST_EV_999",
            "event_type": "planned",
            "event_cause": "procession",
            "latitude": 12.97883,
            "longitude": 77.59953,
            "priority": "High",
            "requires_road_closure": True,
            "severity_index": 5.5,
            "duration_mins": 60.0,
            "congestion_level": "Moderate",
            "impact_radius_km": 1.1,
            "response_time_mins": 12.0,
            "dispatches": [
                {
                    "station_name": "Halasuru Gate",
                    "officers": 2,
                    "barricades": 5,
                    "vehicles": 1,
                    "transit_distance_km": 1.2
                }
            ],
            "start_datetime_ist": "2026-06-20T17:00:00"
        }
        response = self.client.post("/events/deploy", json=deploy_payload)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["id"], "TEST_EV_999")
        self.assertEqual(data["status"], "Live Event")

        # Verify resource deduction
        r_stations = self.client.get("/stations")
        stations_data = r_stations.json()
        self.assertGreaterEqual(stations_data["Halasuru Gate"]["deployed_officers"], 2)

        # 2. Reassess Event
        reassess_payload = {
            "id": "TEST_EV_999"
        }
        response_re = self.client.post("/events/reassess", json=reassess_payload)
        self.assertEqual(response_re.status_code, 200)
        re_data = response_re.json()
        self.assertIn("resource_recommendations", re_data)

        # 3. Close Event
        close_payload = {
            "id": "TEST_EV_999",
            "actual_duration_mins": 65.0,
            "actual_severity_index": 5.4,
            "actual_congestion": "Moderate",
            "actual_impact_radius_km": 1.0,
            "actual_response_time_mins": 11.5,
            "additional_officers_requested": 0,
            "additional_barricades_requested": 0,
            "additional_vehicles_requested": 0,
            "manual_operator_adjustments": "None"
        }
        response_close = self.client.post("/events/close", json=close_payload)
        self.assertEqual(response_close.status_code, 200)
        close_data = response_close.json()
        self.assertEqual(close_data["status"], "success")

        # Verify resource release
        r_stations_after = self.client.get("/stations")
        stations_data_after = r_stations_after.json()
        self.assertEqual(stations_data_after["Halasuru Gate"]["deployed_officers"], stations_data["Halasuru Gate"]["deployed_officers"] - 2)

if __name__ == "__main__":
    unittest.main()
