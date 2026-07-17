import os
import argparse
import numpy as np
from PIL import Image

def generate_flowmap(heightmap_path, output_path, strength=10.0):
    print(f"Loading heightmap from {heightmap_path}...")
    img = Image.open(heightmap_path)
    
    # Convert 16-bit image to float32 [0.0, 1.0]
    h_data = np.array(img, dtype=np.float32) / 65535.0
    
    print("Computing terrain gradients...")
    # np.gradient returns (dy, dx). y is axis 0, x is axis 1
    dy, dx = np.gradient(h_data)
    
    # Flow direction is downhill (negative gradient)
    flow_x = -dx * strength
    flow_y = -dy * strength
    
    # Optional: apply a slight blur/smoothing here if needed, 
    # but native gradient is usually fine for flow assist maps.
    
    # Clip vectors to [-1.0, 1.0] range to prevent overflow mapping
    flow_x = np.clip(flow_x, -1.0, 1.0)
    flow_y = np.clip(flow_y, -1.0, 1.0)
    
    print("Mapping vectors to RGB space...")
    # Map [-1, 1] to [0, 255]
    r = ((flow_x * 0.5 + 0.5) * 255).astype(np.uint8)
    g = ((flow_y * 0.5 + 0.5) * 255).astype(np.uint8)
    
    # Blue channel can be used for flow magnitude or left neutral (128 or 255)
    # We will set it to 128 (neutral Z)
    b = np.full_like(r, 128)
    
    flow_rgb = np.stack([r, g, b], axis=-1)
    
    print(f"Saving flowmap to {output_path}...")
    # Ensure directory exists
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    out_img = Image.fromarray(flow_rgb, mode='RGB')
    
    # Optimize compress_level for highly compressible flow gradients
    out_img.save(output_path, format="PNG", optimize=True)
    print("Done! Flowmap generated successfully.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate 2D flowmap vectors from a 16-bit heightmap")
    parser.add_argument("--input", default="assets/heightmap.png", help="Path to input 16-bit heightmap")
    parser.add_argument("--output", default="assets/flowmap.png", help="Path to output flowmap")
    parser.add_argument("--strength", type=float, default=25.0, help="Gradient multiplier strength")
    args = parser.parse_args()
    
    if not os.path.exists(args.input):
        print(f"Error: Could not find input heightmap at '{args.input}'. Are you running this in the server/ directory?")
        exit(1)
        
    generate_flowmap(args.input, args.output, strength=args.strength)
