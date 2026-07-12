#!/usr/bin/env python3
# height_extractor.py (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
# Licensed under the MIT License (see LICENSE for details)
"""
LOTRO Terrain Heightmap Extractor
Extracts raw 16-bit height values from LOTRO client_cell_N.dat files on a per-region basis,
generating high-fidelity 8192x8192 grayscale PNG heightmaps for the climate simulator.
"""

import os
import sys
import struct
import zlib
import argparse
import numpy as np
from PIL import Image

# Helper functions for binary parsing
def zeros(s):
    if isinstance(s, str):
        return s == "\0" * len(s)
    return s == b"\0" * len(s)

def dword(buf, offset):
    return struct.unpack("<L", buf[offset:offset + 4])[0]

class Directory:
    def __init__(self, dat_file, offset):
        self.dat_file = dat_file
        self.offset = offset
        self.subdir_ptrs = []
        self.file_ptrs = []

        f = self.dat_file.stream
        f.seek(offset)
        row = f.read(0x08)
        assert zeros(row), "Directory row must be zero-initialized"

        # Read sub-directories
        f.seek(offset + 0x08)
        for i in range(62):
            row = f.read(0x08)
            block_size, dir_offset = struct.unpack("<LL", row)
            if block_size == 0:
                break
            self.subdir_ptrs.append((i, block_size, dir_offset))

        f.seek(offset + (0x08 * 63))
        self.count = struct.unpack("<L", f.read(4))[0]
        self.subdir_ptrs = self.subdir_ptrs[:self.count + 1]

        # Read files
        for i in range(self.count):
            d = f.read(0x20)
            if len(d) < 0x20:
                break
            unk1, file_id, file_offset, size1, timestamp, version, size2, unk2 = \
                struct.unpack("<LLLLLLLL", d)
            if size1 > 0:
                self.file_ptrs.append((i, unk1, file_id, file_offset, size1, timestamp, version, size2, unk2))

class DatFile:
    def __init__(self, filename):
        self.filename = filename
        self.file_size = os.stat(filename).st_size
        self.stream = open(filename, "rb")
        self.block_cache = {}
        self.dir_cache = {}
        buf = self.stream.read(1024)
        self.read_super_block(buf)

    def read_super_block(self, buf):
        assert dword(buf, 0x101) == 0x4C50, "Invalid super block magic (PL)"
        assert dword(buf, 0x140) == 0x5442, "Invalid super block magic (TB)"

        self.block_size = dword(buf, 0x144)
        self.size = dword(buf, 0x148)
        self.version = dword(buf, 0x14C)
        self.version_2 = dword(buf, 0x150)
        self.free_head = dword(buf, 0x154)
        self.free_tail = dword(buf, 0x158)
        self.free_size = dword(buf, 0x15C)
        self.directory_offset = dword(buf, 0x160)

        assert self.file_size == self.size, f"File size mismatch: {self.file_size} != {self.size}"

    def directory(self, offset=None):
        if offset is None:
            offset = self.directory_offset
        if offset in self.dir_cache:
            return self.dir_cache[offset]
        d = Directory(self, offset)
        self.dir_cache[offset] = d
        return d

    def visit_file_entries(self, visitor, offset=None):
        d = self.directory(offset)
        if d.subdir_ptrs:
            for i, block_size, dir_offset in d.subdir_ptrs:
                self.visit_file_entries(visitor, dir_offset)
                if i < d.count:
                    # Guard index out of range
                    if i < len(d.file_ptrs):
                        visitor(d.file_ptrs[i])
        else:  # leaf
            for file_entry in d.file_ptrs:
                visitor(file_entry)

# Load HEIGHTS_PATH from .env
def load_env_heights_path():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    heights_path = os.path.join(script_dir, "assets")
    # Check current directory and parent directory for .env
    for path in [".env", "../.env", "server/.env"]:
        if os.path.exists(path):
            try:
                with open(path, "r") as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith("HEIGHTS_PATH="):
                            val = line.split("=", 1)[1].strip()
                            if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                                val = val[1:-1]
                            heights_path = val
                            break
            except Exception as e:
                print(f"[Warning] Failed to read .env from {path}: {e}")
    return heights_path

# Mapped region names and dat indexes
REGIONS = {
    1: {"name": "eriador", "file": "client_cell_1.dat", "prefix": 0x80010000},
    2: {"name": "rhovanion", "file": "client_cell_2.dat", "prefix": 0x80020000},
    3: {"name": "rohan", "file": "client_cell_3.dat", "prefix": 0x80030000},
    4: {"name": "gondor", "file": "client_cell_4.dat", "prefix": 0x80040000},
    5: {"name": "umbar", "file": "client_cell_5.dat", "prefix": 0x80050000},
    14: {"name": "instance_14", "file": "client_cell_14.dat", "prefix": 0x800E0000},
    15: {"name": "instance_15", "file": "client_cell_15.dat", "prefix": 0x800F0000},
}

def extract_region_heightmap(heights_path, region_id, output_dir):
    region_info = REGIONS.get(region_id)
    if not region_info:
        print(f"[Error] Unsupported region ID: {region_id}")
        return False

    dat_filename = os.path.join(heights_path, region_info["file"])
    if not os.path.exists(dat_filename):
        print(f"[Error] LOTRO data file not found: {dat_filename}")
        print("Please verify that HEIGHTS_PATH is set correctly in your .env configuration.")
        return False

    print(f"\n--- Extracting Region {region_id} ({region_info['name'].capitalize()}) ---")
    print(f"Reading from: {dat_filename}")
    
    try:
        dat_file = DatFile(dat_filename)
    except Exception as e:
        print(f"[Error] Failed to open dat file: {e}")
        return False

    # Initialize a 2D grid for the region (256x256 cells * 32x32 vertices per cell = 8192x8192)
    grid = np.zeros((8192, 8192), dtype=np.uint16)
    cells_extracted = 0
    prefix = region_info["prefix"]

    def process_entry(entry):
        nonlocal cells_extracted
        j, unk1, file_id, offset, size1, timestamp, version, size2, unk2 = entry
        
        # We only want landblock cell files belonging to this region
        if (file_id & 0xFFFF0000) != prefix:
            return

        dat_file.stream.seek(offset)
        j_val, k_val, l_val, m_val, n_val = struct.unpack("<LLLHH", dat_file.stream.read(0x10))
        
        # Validate and decompress zlib blocks
        if m_val == 0xDA78:
            dat_file.stream.seek(offset)
            compressed_data = dat_file.stream.read(size1 + 0x08)[12:]
            try:
                content = zlib.decompress(compressed_data)
            except zlib.error:
                return
        else:
            if unk1 % 0x100 == 0x02:
                dat_file.stream.seek(offset)
                content = dat_file.stream.read(size1 + 0x08)[8:]
            else:
                return

        # Ensure content has the complete 33x33 vertex height data (0x441 * 2 bytes)
        if len(content) < 0x10 + (0x441 * 2):
            return

        # Unpack X and Y cell coordinates
        cy = (file_id & 0x0000FF00) >> 8
        cx = file_id & 0x000000FF

        data = content[0x10:0x10 + (0x441 * 2)]
        
        # Populate the global 8192x8192 grid
        # Discard the shared 33rd vertex to keep cells perfectly adjacent without seams
        for local_y in range(32):
            for local_x in range(32):
                o = (local_y * 33 + local_x) * 2
                h = struct.unpack("<H", data[o:o + 2])[0]
                
                # Flip the Y coordinate so that cy=255/local_y=31 (North) is at the top (0)
                # and cy=0/local_y=0 (South) is at the bottom (8191)
                grid_y = 8191 - (cy * 32 + local_y)
                grid_x = cx * 32 + local_x
                
                grid[grid_y, grid_x] = h
                
        cells_extracted += 1
        if cells_extracted % 2000 == 0:
            print(f"  Processed {cells_extracted} cells...")

    dat_file.visit_file_entries(process_entry)
    print(f"Extraction complete. Processed {cells_extracted} terrain cells.")

    if cells_extracted == 0:
        print("[Warning] No terrain cells found. Heightmap will be blank.")

    # Save to generated-heights folder as 16-bit Grayscale PNG
    os.makedirs(output_dir, exist_ok=True)
    out_filename = os.path.join(output_dir, f"{region_info['name']}_heightmap.png")
    
    print(f"Saving 16-bit heightmap to: {out_filename}")
    img = Image.fromarray(grid, mode="I;16")
    img.save(out_filename)
    
    # Print height ranges for calibration analysis
    if cells_extracted > 0:
        non_zero_vals = grid[grid > 0]
        if len(non_zero_vals) > 0:
            print(f"  Terrain stats: Min Height={np.min(non_zero_vals)}, Max Height={np.max(non_zero_vals)}, Avg Height={np.mean(non_zero_vals):.1f}")
        else:
            print("  Terrain stats: Flat ocean level (all heights are 0).")
            
    return True

def main():
    parser = argparse.ArgumentParser(description="LOTRO Terrain Heightmap Extractor (16-bit Grayscale)")
    parser.add_argument(
        "--mode",
        choices=["extract-regions", "stitching"],
        required=True,
        help="Extraction mode: (extract-regions) outputs individual raw regions; (stitching) joins regions based on custom boundaries."
    )
    parser.add_argument(
        "--region",
        default="all",
        help="Region index (1=Eriador, 2=Rhovanion, 3=Rohan, 4=Gondor, 5=Umbar, 14=Instance_14, 15=Instance_15) or 'all'."
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Custom output directory. Defaults to server/assets/generated-heights."
    )

    args = parser.parse_args()

    # Determine paths
    heights_path = load_env_heights_path()
    print(f"Heights Game Data Path: {heights_path}")

    if not heights_path or not os.path.exists(heights_path):
        print(f"[Error] The heights data installation path does not exist: {heights_path}")
        print("Please configure the correct HEIGHTS_PATH in your .env file.")
        sys.exit(1)

    # Determine output path
    if args.output_dir:
        output_dir = args.output_dir
    else:
        # Default output directory is server/assets/generated-heights
        current_dir = os.path.dirname(os.path.abspath(__file__))
        output_dir = os.path.join(current_dir, "assets", "generated-heights")

    if args.mode == "stitching":
        print("\n=== Stitching Mode (Stubbed) ===")
        print("Stitching requires a custom configuration file mapping cell coordinates across different regional grids.")
        print("This feature is currently stubbed and will be implemented in a future update.")
        sys.exit(0)

    # Mode: extract-regions
    if args.region == "all":
        regions_to_extract = list(REGIONS.keys())
    else:
        try:
            regions_to_extract = [int(args.region)]
        except ValueError:
            print(f"[Error] Invalid region value: {args.region}. Must be an integer or 'all'.")
            sys.exit(1)

    success_count = 0
    for r_id in regions_to_extract:
        if r_id not in REGIONS:
            print(f"[Warning] Region {r_id} is not supported. Skipping.")
            continue
        if extract_region_heightmap(heights_path, r_id, output_dir):
            success_count += 1

    print(f"\n[Summary] Successfully extracted {success_count} region heightmaps under {output_dir}")

if __name__ == "__main__":
    main()
