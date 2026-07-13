# test_physics.py (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
# Licensed under the MIT License (see LICENSE for details)

import pytest
import numpy as np
from physics_solver import WeatherPhysics
from hydrology import HydrologySolver

def test_weather_physics_instantiation():
    """Verify that WeatherPhysics solver instantiates with custom resolution."""
    physics = WeatherPhysics(width=128, height=128, use_gpu=False)
    assert physics.width == 128
    assert physics.height == 128
    assert physics.size == 128 * 128
    assert len(physics.temperature) == 128 * 128

def test_weather_physics_update():
    """Verify that WeatherPhysics updates its fields on CPU."""
    physics = WeatherPhysics(width=128, height=128, use_gpu=False)
    
    # Run initial tick
    physics.update(dt=0.1, time_of_day=480.0, season='summer', 
                   global_wind_speed=15.0, global_wind_angle=270.0, global_temp_shift=0.0)
    
    # Assert temperature grid has values
    assert np.any(physics.temperature != 0.0)
    assert np.all(physics.temperature >= -30.0)
    assert np.all(physics.temperature <= 60.0)

def test_hydrology_solver():
    """Verify that HydrologySolver sweeps flow accumulation."""
    hydrology = HydrologySolver(width=128, height=128)
    assert hydrology.width == 128
    assert hydrology.height == 128
    
    heightmap = np.random.rand(128 * 128).astype(np.float32)
    rain_grid = np.ones(128 * 128, dtype=np.float32) * 0.5
    
    # Run hydrology sweep
    hydrology.update_flow_accumulation(heightmap, rain_grid)
    assert np.any(hydrology.flow_accumulation > 0.0)
