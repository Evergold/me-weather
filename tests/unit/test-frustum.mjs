import * as BABYLON from '@babylonjs/core';

const engine = new BABYLON.NullEngine();
const scene = new BABYLON.Scene(engine);
const camera = new BABYLON.ArcRotateCamera("MainCamera", -Math.PI / 2, Math.PI / 3.6, 2000, new BABYLON.Vector3(0, 0, -200), scene);
scene.activeCamera = camera;
scene.render(); // force projection matrix calculation

const frustumPlanes = BABYLON.Frustum.GetPlanes(camera.getTransformationMatrix());

const t = {
    min: new BABYLON.Vector3(-1000, 0, -1000),
    max: new BABYLON.Vector3(1000, 400, 1000) // assume uScale = 400
};

let visible = true;
for (let p = 0; p < 6; p++) {
    const plane = frustumPlanes[p];
    const pVertex = new BABYLON.Vector3(
        plane.normal.x >= 0 ? t.max.x : t.min.x,
        plane.normal.y >= 0 ? t.max.y : t.min.y,
        plane.normal.z >= 0 ? t.max.z : t.min.z
    );
    
    const dot = BABYLON.Vector3.Dot(plane.normal, pVertex) + plane.d;
    console.log(`Plane ${p}: normal={X: ${plane.normal.x.toFixed(2)} Y: ${plane.normal.y.toFixed(2)} Z: ${plane.normal.z.toFixed(2)}}, d=${plane.d.toFixed(2)}, dot=${dot.toFixed(2)}`);
    if (dot < 0) {
        console.log("CULLED BY PLANE", p);
        visible = false;
        break;
    }
}
console.log("Visible:", visible);
