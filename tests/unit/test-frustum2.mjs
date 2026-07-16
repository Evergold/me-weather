import * as BABYLON from '@babylonjs/core';

const engine = new BABYLON.NullEngine();
const scene = new BABYLON.Scene(engine);
const camera = new BABYLON.ArcRotateCamera("MainCamera", -Math.PI / 2, Math.PI / 3.6, 2000, new BABYLON.Vector3(0, 0, -200), scene);
scene.activeCamera = camera;
scene.render(); // force projection matrix calculation

const frustumPlanes = BABYLON.Frustum.GetPlanes(camera.getTransformationMatrix());

const tilesArray = [];
for(let x = 0; x < 256; x++) {
  for(let y = 0; y < 256; y++) {
    tilesArray.push({
      key: `8_${x}_${y}`,
      min: new BABYLON.Vector3(x*10, 0, y*10),
      max: new BABYLON.Vector3(x*10+10, 100, y*10+10)
    });
  }
}

console.time("cull");
const visibleKeys = new Set();
for (const t of tilesArray) {
    let visible = true;
    for (let p = 0; p < 6; p++) {
        const plane = frustumPlanes[p];
        const pVertex = new BABYLON.Vector3(
            plane.normal.x >= 0 ? t.max.x : t.min.x,
            plane.normal.y >= 0 ? t.max.y : t.min.y,
            plane.normal.z >= 0 ? t.max.z : t.min.z
        );
        
        if (BABYLON.Vector3.Dot(plane.normal, pVertex) + plane.d < 0) {
            visible = false;
            break;
        }
    }
    if (visible) {
        visibleKeys.add(t.key);
    }
}
console.timeEnd("cull");
console.log("Visible:", visibleKeys.size);
