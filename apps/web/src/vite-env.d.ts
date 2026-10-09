/// <reference types="vite/client" />

// MediaPipe ships its worker-loadable WASM factory without type declarations.
declare module '@mediapipe/tasks-vision/vision_wasm_module_internal.js' {
  const ModuleFactory: unknown;
  export default ModuleFactory;
}
