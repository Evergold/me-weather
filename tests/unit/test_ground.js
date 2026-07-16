import * as BABYLON from '@babylonjs/core';
const engine = new BABYLON.NullEngine();
const scene = new BABYLON.Scene(engine);
const start = performance.now();
BABYLON.MeshBuilder.CreateGround("test", {width: 1000, height: 1000, subdivisions: 255}, scene);
console.log("CreateGround took: " + (performance.now() - start) + "ms");
