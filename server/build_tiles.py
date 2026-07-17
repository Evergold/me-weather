import os
import subprocess
import glob
import concurrent.futures
from PIL import Image

def generate_png_tiles(input_img_path, map_type):
    if not os.path.exists(input_img_path):
        print(f"Skipping {input_img_path}, file not found")
        return
        
    print(f"Slicing {input_img_path} into PNG tiles...")
    original_img = Image.open(input_img_path)
    
    # We want each output tile to be 1024x1024 for high quality
    TILE_SIZE = 1024
    
    for z in range(4):
        num_tiles = 1 << z
        
        # Resize the whole image FIRST to prevent edge seam artifacts
        target_size = num_tiles * TILE_SIZE
        if original_img.size[0] == target_size:
            img = original_img
        else:
            # LANCZOS is great for heightmaps, but causes severe ringing artifacts on normal maps!
            filter_type = Image.Resampling.BILINEAR if map_type == "normal" else Image.Resampling.LANCZOS
            img = original_img.resize((target_size, target_size), filter_type)
            
        for tx in range(num_tiles):
            for ty in range(num_tiles):
                crop_x = tx * TILE_SIZE
                crop_y = ty * TILE_SIZE
                
                out_dir = f"../public/assets/tiles/{z}/{map_type}"
                os.makedirs(out_dir, exist_ok=True)
                
                # Crop image precisely along tile boundaries, adding 1 pixel overlap to prevent geometry seams!
                crop_right = crop_x + TILE_SIZE
                crop_bottom = crop_y + TILE_SIZE
                
                # Add 1 pixel overlap if there is an adjacent tile
                if tx < num_tiles - 1:
                    crop_right += 1
                if ty < num_tiles - 1:
                    crop_bottom += 1
                    
                cropped = img.crop((crop_x, crop_y, crop_right, crop_bottom))
                
                out_png = f"{out_dir}/{tx}_{ty}.png"
                cropped.save(out_png)

if __name__ == "__main__":
    # Ensure this script is run from the server directory
    if not os.path.exists("assets/heightmap.png"):
        print("Error: Please run this script from the 'server' directory.")
        exit(1)
        
    generate_png_tiles("assets/heightmap.png", "height")
    generate_png_tiles("assets/normalmap.png", "normal")
    generate_png_tiles("assets/flowmap.png", "flow")
    print("Successfully built all environment tiles into PNG format.")
