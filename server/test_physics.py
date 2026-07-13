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

def test_cpu_gpu_consistency():
    """Verify that CPU and GPU simulation pipelines match outputs within float tolerance."""
    physics_cpu = WeatherPhysics(width=128, height=128, use_gpu=False)
    physics_gpu = WeatherPhysics(width=128, height=128, use_gpu=True)
    
    # Check if GPU is actually supported/available on testing environment
    if not physics_gpu.use_gpu:
        pytest.skip("WebGPU is not supported/initialized on this hardware/driver environment.")
        
    # Generate identical initial dummy heightmaps
    h_data = np.random.rand(128 * 128).astype(np.float32) * 0.5
    
    physics_cpu.heightmap = h_data.copy()
    physics_cpu.is_water = (h_data < 0.08).astype(np.uint32)
    physics_cpu.moisture = np.where(physics_cpu.is_water == 1, 0.9, 0.4).astype(np.float32)
    physics_cpu.temperature.fill(15.0)
    physics_cpu.pressure.fill(1013.0)
    
    physics_gpu.heightmap = h_data.copy()
    physics_gpu.is_water = (h_data < 0.08).astype(np.uint32)
    physics_gpu.moisture = np.where(physics_gpu.is_water == 1, 0.9, 0.4).astype(np.float32)
    physics_gpu.temperature.fill(15.0)
    physics_gpu.pressure.fill(1013.0)
    
    # Upload to GPU
    physics_gpu.device.queue.write_buffer(physics_gpu.gpu_buffers["heightmap"], 0, physics_gpu.heightmap)
    physics_gpu.device.queue.write_buffer(physics_gpu.gpu_buffers["is_water"], 0, physics_gpu.is_water)
    physics_gpu.device.queue.write_buffer(physics_gpu.gpu_buffers["moisture"], 0, physics_gpu.moisture)
    physics_gpu.device.queue.write_buffer(physics_gpu.gpu_buffers["temperature"], 0, physics_gpu.temperature)
    physics_gpu.device.queue.write_buffer(physics_gpu.gpu_buffers["pressure"], 0, physics_gpu.pressure)
    
    # Run multiple steps
    for _ in range(5):
        physics_cpu.update(dt=0.1, time_of_day=480.0, season='summer', 
                           global_wind_speed=15.0, global_wind_angle=270.0, global_temp_shift=0.0)
        physics_gpu.update(dt=0.1, time_of_day=480.0, season='summer', 
                           global_wind_speed=15.0, global_wind_angle=270.0, global_temp_shift=0.0)
                           
    # Compare outputs
    
    assert np.allclose(physics_cpu.temperature, physics_gpu.temperature, atol=1e-2)
    assert np.allclose(physics_cpu.pressure, physics_gpu.pressure, atol=1e-2)
    assert np.allclose(physics_cpu.windX, physics_gpu.windX, atol=1e-2)
    assert np.allclose(physics_cpu.windY, physics_gpu.windY, atol=1e-2)
    assert np.allclose(physics_cpu.moisture, physics_gpu.moisture, atol=1e-2)
    assert np.allclose(physics_cpu.rain, physics_gpu.rain, atol=1e-2)
    assert np.allclose(physics_cpu.snow, physics_gpu.snow, atol=1e-2)
