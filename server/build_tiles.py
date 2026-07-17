import os
import subprocess
import glob
import concurrent.futures
from PIL import Image

def generate_png_tiles(input_img_path, map_type, use_ktx2=False):
    if not os.path.exists(input_img_path):
        print(f"Skipping {input_img_path}, file not found")
        return
        
    print(f"Slicing {input_img_path} into tiles (KTX2: {use_ktx2})...")
    original_img = Image.open(input_img_path)
    
    # We want each output tile to be 1024x1024 for high quality
    TILE_SIZE = 1024
    
    generated_pngs = []
    
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
                generated_pngs.append(out_png)

    if use_ktx2 and generated_pngs:
        print(f"Compressing {len(generated_pngs)} PNGs to KTX2 format using basisu...")
        def convert_to_ktx2(png_path):
            try:
                # Compile to Basis Universal KTX2 format
                subprocess.run(
                    ["basisu", "-ktx2", "-y_flip", os.path.basename(png_path)], 
                    cwd=os.path.dirname(png_path), 
                    stdout=subprocess.DEVNULL, 
                    stderr=subprocess.DEVNULL,
                    check=True
                )
                # Remove the uncompressed PNG
                os.remove(png_path)
            except Exception as e:
                print(f"Failed to convert {png_path} to KTX2: {e}")

        with concurrent.futures.ThreadPoolExecutor() as executor:
            executor.map(convert_to_ktx2, generated_pngs)

if __name__ == "__main__":
    # Ensure this script is run from the server directory
    if not os.path.exists("assets/heightmap.png"):
        print("Error: Please run this script from the 'server' directory.")
        exit(1)
        
    generate_png_tiles("assets/heightmap.png", "height", use_ktx2=False)
    generate_png_tiles("assets/normalmap.png", "normal", use_ktx2=False)
    generate_png_tiles("assets/flowmap.png", "flow", use_ktx2=False)
    
    # Example for future detail textures:
    # generate_png_tiles("assets/grass.png", "diffuse", use_ktx2=True)
    
    print("Successfully built all environment tiles.")
