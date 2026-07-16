import fs from 'fs';
const data = fs.readFileSync('public/assets/heightmap_coarse.png');
// We need to parse PNG to see the heightmap, wait, we have physics.js which downloads it?
