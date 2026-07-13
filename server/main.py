# main.py (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
# Licensed under the MIT License (see LICENSE for details)

import os
import sys
import asyncio
import math
import subprocess
import json
import numpy as np
from PIL import Image
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import uvicorn
from dotenv import load_dotenv

# Load environment configuration
load_dotenv()

from physics_solver import WeatherPhysics
from hydrology import HydrologySolver

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Start background physics solver task
    task = asyncio.create_task(simulation_loop())
    yield
    # Clean up task on shutdown
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass

app = FastAPI(title="Middle-earth Weather Simulation Server", lifespan=lifespan)

# Configure CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Server Configuration parameters
PAUSE_ON_IDLE = os.getenv("PAUSE_ON_IDLE", "True").lower() == "true"
DECOUPLE_HYDROLOGY = os.getenv("DECOUPLE_HYDROLOGY", "False").lower() == "true"

HEIGHTMAP_FILENAME = os.getenv("HEIGHTMAP_FILENAME", "heightmap.png")
NORMALMAP_FILENAME = os.getenv("NORMALMAP_FILENAME", "normalmap.png")
TILED_IMPORT_DIR_NAME = os.getenv("TILED_IMPORT_DIR", "")

# Paths
ASSETS_DIR = os.path.join(os.path.dirname(__file__), "assets")
TILES_DIR = os.path.join(ASSETS_DIR, "tiles")
HEIGHTMAP_PATH = os.path.join(ASSETS_DIR, HEIGHTMAP_FILENAME)
NORMALMAP_PATH = os.path.join(ASSETS_DIR, NORMALMAP_FILENAME)
COARSE_HEIGHTMAP_PATH = os.path.join(ASSETS_DIR, "heightmap_coarse.png")
COARSE_NORMALMAP_PATH = os.path.join(ASSETS_DIR, "normalmap_coarse.jpg")

IS_TILED_MODE = False
tiled_manifest = None
tiled_source_dir = ""

if TILED_IMPORT_DIR_NAME:
    tiled_source_dir = os.path.join(ASSETS_DIR, TILED_IMPORT_DIR_NAME)
    manifest_path = os.path.join(tiled_source_dir, "manifest.json")
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, "r") as f:
                tiled_manifest = json.load(f)
            IS_TILED_MODE = True
            print(f"[Tiled Import] Active. Loaded manifest: {tiled_manifest['name']} ({tiled_manifest['totalResolution']}x{tiled_manifest['totalResolution']})")
        except Exception as e:
            print(f"[Tiled Import] Failed to load manifest: {e}")

# Enforce that terrain files exist in assets folder before proceeding
if not IS_TILED_MODE:
    if not os.path.exists(HEIGHTMAP_PATH) or not os.path.exists(NORMALMAP_PATH):
        print("\n" + "="*80)
        print(" CRITICAL STARTUP ERROR: Missing Master Terrain Map Assets!")
        print(f" Heightmap expected at: {HEIGHTMAP_PATH}")
        print(f" Normalmap expected at: {NORMALMAP_PATH}")
        print(" Please place your terrain assets in the server assets folder and try again.")
        print("="*80 + "\n")
        sys.exit(1)

# Dynamically read simulation grid dimensions from master heightmap size
SIM_WIDTH, SIM_HEIGHT = 1024, 1024
if IS_TILED_MODE:
    SIM_WIDTH = tiled_manifest["totalResolution"]
    SIM_HEIGHT = tiled_manifest["totalResolution"]
    print(f"[Assets] Tiled Map dimensions detected dynamically from manifest: {SIM_WIDTH}x{SIM_HEIGHT}")
else:
    try:
        with Image.open(HEIGHTMAP_PATH) as img:
            SIM_WIDTH, SIM_HEIGHT = img.size
        print(f"[Assets] Master heightmap detected dynamically: {SIM_WIDTH}x{SIM_HEIGHT}")
    except Exception as e:
        print(f"[Error] Failed to read heightmap dimensions: {e}")
        sys.exit(1)

# Configure simulation dimensions based on WebGPU availability
from physics_solver import HAS_WGPU
if not HAS_WGPU:
    print("[Physics] WebGPU not available. Downsampling simulation grid to 256x256 for real-time CPU ticking.")
    sim_w_solver, sim_h_solver = 256, 256
else:
    sim_w_solver = min(1024, SIM_WIDTH)
    sim_h_solver = min(1024, SIM_HEIGHT)

# Global simulation state
physics = WeatherPhysics(width=sim_w_solver, height=sim_h_solver, use_gpu=True)
hydrology = HydrologySolver(width=sim_w_solver, height=sim_h_solver)

# Global simulation variables (Shared state)
sim_time_of_day = 480.0  # 8:00 AM (minutes past midnight)
sim_season = "summer"
global_wind_speed = 15.0
global_wind_angle = 270.0
global_temp_shift = 0.0
sim_speed = 1.0  # Multiplier

# State locks
state_lock = asyncio.Lock()
connected_clients = set()
pause_on_idle = PAUSE_ON_IDLE
is_running = True

# Make folders
os.makedirs(ASSETS_DIR, exist_ok=True)
os.makedirs(TILES_DIR, exist_ok=True)

def get_chunk_from_tiled_source(left, top, right, bottom, source_dir, manifest, map_type):
    tile_size = manifest["tileSize"]
    grid_size = manifest["gridSize"]
    naming_pattern = manifest["tileNamingPattern"]
    file_format = manifest.get("fileFormat", "png")
    
    start_tile_x = int(left // tile_size)
    start_tile_y = int(top // tile_size)
    end_tile_x = int((right - 1) // tile_size)
    end_tile_y = int((bottom - 1) // tile_size)
    
    chunk_w = right - left
    chunk_h = bottom - top
    canvas = Image.new("RGBA" if file_format.lower() in ["png", "exr", "tif", "tiff"] else "RGB", (chunk_w, chunk_h))
    
    for tx in range(start_tile_x, end_tile_x + 1):
        for ty in range(start_tile_y, end_tile_y + 1):
            if tx < 0 or tx >= grid_size or ty < 0 or ty >= grid_size:
                continue
            
            tile_name = naming_pattern.replace("{x}", str(tx)).replace("{y}", str(ty))
            tile_path = os.path.join(source_dir, map_type, tile_name)
            
            if not os.path.exists(tile_path):
                print(f"[Tiled Import] Missing source tile: {tile_path}")
                continue
                
            with Image.open(tile_path) as tile_img:
                inter_left = max(left, tx * tile_size)
                inter_top = max(top, ty * tile_size)
                inter_right = min(right, (tx + 1) * tile_size)
                inter_bottom = min(bottom, (ty + 1) * tile_size)
                
                rel_left = inter_left - tx * tile_size
                rel_top = inter_top - ty * tile_size
                rel_right = inter_right - tx * tile_size
                rel_bottom = inter_bottom - ty * tile_size
                
                cropped = tile_img.crop((rel_left, rel_top, rel_right, rel_bottom))
                
                paste_x = inter_left - left
                paste_y = inter_top - top
                canvas.paste(cropped, (paste_x, paste_y))
                
    return canvas

# Pre-slicing terrain tiles on startup
def pre_slice_map(img_path, map_type="height"):
    """Pre-slices the master image dynamically based on dimensions (level 0 up to 5 or 6)."""
    if not IS_TILED_MODE:
        if not os.path.exists(img_path):
            print(f"[Tile Server] {map_type} map not found at {img_path}. Skipping pre-slicing.")
            return
        img = Image.open(img_path)
        w, h = img.size
    else:
        w = SIM_WIDTH
        h = SIM_HEIGHT

    # Calculate max zoom dynamically: 256px tile size.
    max_zoom = int(math.log2(w // 256))
    max_zoom = max(0, min(7, max_zoom)) # clamp Z to sensible bounds [0, 7]

    print(f"[Tile Server] Pre-slicing {map_type} map dynamically (Z=0 to Z={max_zoom})...")

    for z in range(max_zoom + 1):
        tiles_count = 2 ** z
        chunk_w = w // tiles_count
        chunk_h = h // tiles_count
        
        os.makedirs(os.path.join(TILES_DIR, str(z), map_type), exist_ok=True)

        for x in range(tiles_count):
            for y in range(tiles_count):
                tile_filename = os.path.join(TILES_DIR, str(z), map_type, f"{x}_{y}.png")
                
                # Check if tile already exists to save time on restarts
                if os.path.exists(tile_filename):
                    continue

                # Crop and resize chunk
                left = x * chunk_w
                top = y * chunk_h
                right = left + chunk_w
                bottom = top + chunk_h
                
                if IS_TILED_MODE:
                    tile_img = get_chunk_from_tiled_source(left, top, right, bottom, tiled_source_dir, tiled_manifest, map_type)
                    if map_type == "height":
                        if tile_img.mode in ["F", "I;16", "I"]:
                            tile_img = tile_img.convert("F").point(lambda x: x / 256.0).convert("L").convert("RGBA")
                        else:
                            tile_img = tile_img.convert("RGBA")
                    else:
                        tile_img = tile_img.convert("RGB")
                    tile_img = tile_img.resize((256, 256), Image.Resampling.BILINEAR)
                else:
                    crop_box = (left, top, right, bottom)
                    tile_img = img.crop(crop_box).resize((256, 256), Image.Resampling.BILINEAR)
                
                tile_img.save(tile_filename)

    print(f"[Tile Server] Pre-slicing completed for {map_type} map.")

# Generate coarse versions (1024x1024) on startup to ensure correct format and depth
print("[Assets] Generating coarse heightmap and normalmap...")
try:
    if IS_TILED_MODE:
        if not os.path.exists(COARSE_HEIGHTMAP_PATH):
            print("[Tiled Import] Generating heightmap_coarse.png from tiled source...")
            h_img_master = get_chunk_from_tiled_source(0, 0, SIM_WIDTH, SIM_HEIGHT, tiled_source_dir, tiled_manifest, "height")
            if h_img_master.mode in ["F", "I;16", "I"]:
                h_img_scaled = h_img_master.convert("F").point(lambda x: x / 256.0).convert("L").convert("RGBA")
            else:
                h_img_scaled = h_img_master.convert("RGBA")
            h_img_1024 = h_img_scaled.resize((1024, 1024), Image.Resampling.BILINEAR)
            h_img_1024.save(COARSE_HEIGHTMAP_PATH)
            
        if not os.path.exists(COARSE_NORMALMAP_PATH):
            print("[Tiled Import] Generating normalmap_coarse.jpg from tiled source...")
            n_img_master = get_chunk_from_tiled_source(0, 0, SIM_WIDTH, SIM_HEIGHT, tiled_source_dir, tiled_manifest, "normal")
            n_img_1024 = n_img_master.convert("RGB").resize((1024, 1024), Image.Resampling.BILINEAR)
            n_img_1024.save(COARSE_NORMALMAP_PATH, "JPEG", quality=90)
    else:
        # Open 16-bit heightmap, scale down to 8-bit correctly to avoid Pillow's raw clamping bug, and convert to RGBA
        h_img_master = Image.open(HEIGHTMAP_PATH)
        h_img_scaled = h_img_master.convert("F").point(lambda x: x / 256.0).convert("L").convert("RGBA")
        
        # 1024px for High-Res 3D Terrain Displacement
        h_img_1024 = h_img_scaled.resize((1024, 1024), Image.Resampling.BILINEAR)
        h_img_1024.save(COARSE_HEIGHTMAP_PATH)
        
        n_img_1024 = Image.open(NORMALMAP_PATH).convert("RGB").resize((1024, 1024), Image.Resampling.BILINEAR)
        n_img_1024.save(COARSE_NORMALMAP_PATH, "JPEG", quality=90)
except Exception as e:
    print(f"[Error] Failed to generate coarse maps: {e}")
    sys.exit(1)

pre_slice_map(HEIGHTMAP_PATH, "height")
pre_slice_map(NORMALMAP_PATH, "normal")

# Load heightmap into physics solver
if IS_TILED_MODE:
    physics.load_heightmap(COARSE_HEIGHTMAP_PATH)
else:
    physics.load_heightmap(HEIGHTMAP_PATH)

# HTTP routes for serving terrain tiles and assets
@app.get("/assets/{filename}")
def get_asset(filename: str):
    """Serves static maps (e.g. coarse maps)."""
    file_path = os.path.join(ASSETS_DIR, filename)
    if os.path.exists(file_path):
        return FileResponse(file_path)
    return {"error": "File not found"}

@app.get("/tiles/{z}/{map_type}/{x}_{y}.png")
def get_tile(z: int, map_type: str, x: int, y: int):
    """Serves static height/normal map tiles."""
    tile_path = os.path.join(TILES_DIR, str(z), map_type, f"{x}_{y}.png")
    if os.path.exists(tile_path):
        return FileResponse(tile_path)
    # Fallback to level 0 tile if chunk not found
    fallback = os.path.join(TILES_DIR, "0", map_type, "0_0.png")
    if os.path.exists(fallback):
        return FileResponse(fallback)
    return FileResponse(HEIGHTMAP_PATH)

# Client configuration model
class ClientSettings(BaseModel):
    push_rate: str  # "real-time" | "250ms" | "500ms" | "1000ms"
    zoomed_in: bool
    focus_x: float  # Normalized [0, 1]
    focus_y: float  # Normalized [0, 1]

# Main simulation tick loop
async def simulation_loop():
    global sim_time_of_day, sim_season, global_wind_speed, global_wind_angle, global_temp_shift, sim_speed
    last_time = asyncio.get_event_loop().time()
    
    print("[Simulation] Continuous physics engine started.")
    decouple_timer = 0.0
    
    while is_running:
        current_time = asyncio.get_event_loop().time()
        dt = current_time - last_time
        last_time = current_time

        # Cap dt to avoid huge jumps
        if dt > 0.2:
            dt = 0.2

        # Read current parameters under lock
        async with state_lock:
            clients_count = len(connected_clients)
            current_sim_speed = sim_speed
            current_time_of_day = sim_time_of_day
            current_season = sim_season
            current_wind_speed = global_wind_speed
            current_wind_angle = global_wind_angle
            current_temp_shift = global_temp_shift

        # Check idle pause state
        if pause_on_idle and clients_count == 0:
            await asyncio.sleep(0.5)
            continue

        if current_sim_speed > 0:
            # Advance time of day
            next_time_of_day = (current_time_of_day + dt * current_sim_speed * 1.5) % 1440.0
            
            # Write advanced time back to shared state under lock
            async with state_lock:
                sim_time_of_day = next_time_of_day

            # Tick physics in background thread to avoid blocking main thread
            await asyncio.to_thread(
                physics.update,
                dt * current_sim_speed,
                next_time_of_day,
                current_season,
                current_wind_speed,
                current_wind_angle,
                current_temp_shift
            )

        # Allow context switching and pace the ticks
        await asyncio.sleep(0.01)

# WebSocket connection manager
class ConnectionManager:
    def __init__(self):
        self.active_connections = {}

    async def connect(self, websocket: WebSocket, client_id: str):
        await websocket.accept()
        self.active_connections[client_id] = {
            "socket": websocket,
            "push_rate": "1000ms",  # default
            "zoomed_in": False,
            "focus_x": 0.5,
            "focus_y": 0.5,
            "task": None
        }
        connected_clients.add(client_id)
        # Start client-specific push task
        self.active_connections[client_id]["task"] = asyncio.create_task(
            self.client_push_worker(client_id)
        )

    def disconnect(self, client_id: str):
        if client_id in self.active_connections:
            self.active_connections[client_id]["task"].cancel()
            del self.active_connections[client_id]
        connected_clients.discard(client_id)

    async def update_settings(self, client_id: str, settings: dict):
        if client_id in self.active_connections:
            # Update local parameters safely
            self.active_connections[client_id]["push_rate"] = settings.get("push_rate", "1000ms")
            self.active_connections[client_id]["zoomed_in"] = settings.get("zoomed_in", False)
            self.active_connections[client_id]["focus_x"] = settings.get("focus_x", 0.5)
            self.active_connections[client_id]["focus_y"] = settings.get("focus_y", 0.5)

    async def client_push_worker(self, client_id: str):
        """Worker loop that handles custom data delivery rates per client connection."""
        client = self.active_connections[client_id]
        sock = client["socket"]

        while True:
            try:
                rate_str = client["push_rate"]
                
                # Determine sleep duration
                if rate_str == "real-time":
                    sleep_time = 0.05  # Push as fast as loop ticks
                elif rate_str == "250ms":
                    sleep_time = 0.25
                elif rate_str == "500ms":
                    sleep_time = 0.50
                else:
                    sleep_time = 1.0

                await asyncio.sleep(sleep_time)

                # Package the grid binary data
                async with state_lock:
                    if client["zoomed_in"]:
                        # Send high-resolution viewport chunk matching client 256x256 buffer size
                        fx = int(client["focus_x"] * physics.width) - 128
                        fy = int(client["focus_y"] * physics.height) - 128
                        fx = max(0, min(physics.width - 256, fx))
                        fy = max(0, min(physics.height - 256, fy))
                        
                        binary_data = physics.get_serialized_chunk(fx, fy, chunk_size=256)
                        message_header = b"\x01"  # 1 byte header: Chunk Data type
                    else:
                        # Send downsampled global overlay matching client 256x256 buffer size
                        ds_factor = max(1, physics.width // 256)
                        binary_data = physics.get_serialized_grid(downsample_factor=ds_factor)
                        message_header = b"\x00"  # 0 byte header: Global Overlay type

                # Send binary packet
                await sock.send_bytes(message_header + binary_data)
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"[WebSocket] Error pushing to client {client_id}: {e}")
                break

manager = ConnectionManager()

@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    await manager.connect(websocket, client_id)
    try:
        while True:
            # Listen for client setting changes or control edits
            data = await websocket.receive_json()
            
            # If client changed simulation parameters (Season, Wind, Time), update globally
            global sim_time_of_day, sim_season, global_wind_speed, global_wind_angle, global_temp_shift, sim_speed
            async with state_lock:
                if "timeOfDay" in data:
                    sim_time_of_day = float(data["timeOfDay"])
                if "season" in data:
                    sim_season = data["season"]
                if "windSpeed" in data:
                    global_wind_speed = float(data["windSpeed"])
                if "windAngle" in data:
                    global_wind_angle = float(data["windAngle"])
                if "tempShift" in data:
                    global_temp_shift = float(data["tempShift"])
                if "simSpeed" in data:
                    sim_speed = float(data["simSpeed"])

            # Update local subscription rate and viewport focus
            await manager.update_settings(client_id, data)

    except WebSocketDisconnect:
        manager.disconnect(client_id)
        print(f"[WebSocket] Client {client_id} disconnected.")
    except Exception as e:
        manager.disconnect(client_id)
        print(f"[WebSocket] Socket connection error: {e}")





if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
