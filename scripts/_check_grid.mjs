import * as THREE from "../docs/assets/vendor/three/three.module.js";

const grid = new THREE.GridHelper(50, 34);
console.log("material isArray:", Array.isArray(grid.material));
console.log("material type:", grid.material.type);
console.log("has color:", !!grid.material.color, "color:", grid.material.color && grid.material.color.getHex());
console.log("has color2:", !!grid.material.color2, "color2:", grid.material.color2 && grid.material.color2.getHex());
console.log("geometry has color attr:", !!grid.geometry.attributes.color);
