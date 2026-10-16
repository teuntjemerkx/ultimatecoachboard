// Puts MediaPipe's runtime and the two models in public/ before a build (they are not kept in git):
// the WebAssembly runtime from node_modules, the models from Google's model storage.
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";

const wasmFrom = "node_modules/@mediapipe/tasks-vision/wasm";
mkdirSync("public/mediapipe", { recursive: true });
for (const f of readdirSync(wasmFrom)) if (!f.includes("module")) copyFileSync(`${wasmFrom}/${f}`, `public/mediapipe/${f}`);

const models = {
  "efficientdet_lite2.tflite": "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float16/latest/efficientdet_lite2.tflite",
  "pose_landmarker_full.task": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task",
};
mkdirSync("public/models", { recursive: true });
for (const [name, url] of Object.entries(models)) {
  const path = `public/models/${name}`;
  if (existsSync(path)) continue;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download ${name}: ${res.status}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  console.log(`downloaded ${name}`);
}
