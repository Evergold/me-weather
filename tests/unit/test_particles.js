import * as BABYLON from '@babylonjs/core';
const engine = new BABYLON.NullEngine();
const scene = new BABYLON.Scene(engine);
const start = performance.now();
new BABYLON.ParticleSystem("test1", 4000, scene).start();
new BABYLON.ParticleSystem("test2", 4000, scene).start();
new BABYLON.ParticleSystem("test3", 6000, scene).start();
console.log("Particles took: " + (performance.now() - start) + "ms");
