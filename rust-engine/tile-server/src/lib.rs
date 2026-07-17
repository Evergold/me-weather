// lib.rs (c) 2026 Evergold <261058386+Evergold@users.noreply.github.com>
// Licensed under the MIT License (see LICENSE for details)

use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    routing::get,
    Router,
};
use image::DynamicImage;
use std::sync::Arc;

// Application state to hold a loaded coarse map in memory for fast serving
struct AppState {
    coarse_heightmap: DynamicImage,
    coarse_normalmap: DynamicImage,
}

pub fn build_router() -> Router {
    tracing::info!("[Tile Server] Initializing high-speed Rust tile routes...");

    // Load master coarse maps (simulating the load-on-demand cache)
    let heightmap_filename = std::env::var("HEIGHTMAP_FILENAME").unwrap_or_else(|_| "heightmap_coarse.png".to_string());
    let normalmap_filename = std::env::var("NORMALMAP_FILENAME").unwrap_or_else(|_| "normalmap_coarse.png".to_string());
    
    let heightmap_path = format!("../server/assets/{}", heightmap_filename);
    let normalmap_path = format!("../server/assets/{}", normalmap_filename);
    
    // Fallback to empty 1024x1024 images if files don't exist during testing
    let coarse_heightmap = image::open(&heightmap_path).unwrap_or_else(|_| DynamicImage::new_luma8(1024, 1024));
    let coarse_normalmap = image::open(&normalmap_path).unwrap_or_else(|_| DynamicImage::new_rgb8(1024, 1024));

    let state = Arc::new(AppState {
        coarse_heightmap,
        coarse_normalmap,
    });

    // Build and return Axum router
    Router::new()
        .route("/tiles/{z}/{map_type}/{x_y}", get(serve_tile))
        .with_state(state)
}

async fn serve_tile(
    Path((z, map_type, x_y)): Path<(u32, String, String)>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    // Parse {x}_{y}.png
    let parts: Vec<&str> = x_y.trim_end_matches(".png").split('_').collect();
    if parts.len() != 2 {
        return (StatusCode::BAD_REQUEST, "Invalid tile coordinate format").into_response();
    }

    let tx: u32 = parts[0].parse().unwrap_or(0);
    let ty: u32 = parts[1].parse().unwrap_or(0);

    // Dynamic 256px tile slicing
    let tile_size = 256;
    
    let source_image = match map_type.as_str() {
        "height" => &state.coarse_heightmap,
        "normal" => &state.coarse_normalmap,
        _ => return (StatusCode::NOT_FOUND, "Unknown map type").into_response(),
    };

// Calculate crop window based on zoom (z) and tile coords (tx, ty)
    // The master map is 1024x1024.
    // At z=0, the world is 1 tile (1x1). The tile covers 1024x1024.
    // At z=1, the world is 2x2 tiles. Each tile covers 512x512.
    // At z=2, the world is 4x4 tiles. Each tile covers 256x256.
    // At z=3, the world is 8x8 tiles. Each tile covers 128x128.
    
    // Scale factor for the source image.
    // At z=0, we want to crop 1024x1024, so crop_size = 1024 / 1 = 1024.
    let num_tiles = 1 << z;
    let crop_size = 1024 / num_tiles;
    
    let crop_x = tx * crop_size;
    let crop_y = ty * crop_size;

    if crop_x + crop_size > source_image.width() || crop_y + crop_size > source_image.height() {
        return (StatusCode::NOT_FOUND, "Tile out of bounds").into_response();
    }

    // Crop the image
    let cropped = source_image.crop_imm(crop_x, crop_y, crop_size, crop_size);
    
    // Scale to 256x256 for the shader
    let tile = cropped.resize_exact(256, 256, image::imageops::FilterType::Triangle);

    // Encode to PNG byte buffer
    let mut bytes: Vec<u8> = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut bytes);
    if tile.write_to(&mut cursor, image::ImageFormat::Png).is_err() {
        return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to encode tile").into_response();
    }

    // Return native PNG byte stream
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "image/png")],
        bytes,
    ).into_response()
}
