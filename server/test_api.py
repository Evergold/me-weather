import pytest
from fastapi.testclient import TestClient
from main import app, manager
import main
import time

client = TestClient(app)

def test_websocket_control_settings():
    """Test that the control WebSocket properly parses settings and updates server globals."""
    with client.websocket_connect("/ws/control/test_client_1") as websocket:
        # Send a settings update
        websocket.send_json({
            "push_rate": "250ms",
            "zoomed_in": True,
            "focus_x": 0.2,
            "focus_y": 0.2,
            "timeOfDay": 1200.0
        })
        
        # Verify manager updated state
        assert manager.clients["test_client_1"]["push_rate"] == "250ms"
        assert manager.clients["test_client_1"]["zoomed_in"] == True
        
        # Verify global time of day was updated
        assert main.sim_time_of_day == 1200.0


