import * as BABYLON from '@babylonjs/core';
const engine = new BABYLON.NullEngine();
const scene = new BABYLON.Scene(engine);
const camera = new BABYLON.ArcRotateCamera("MainCamera", -Math.PI / 2, Math.PI / 3.6, 2000, new BABYLON.Vector3(0, 0, -200), scene);
console.log("radius:", camera.radius);
