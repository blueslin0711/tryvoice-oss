// On-demand script loader for heavy third-party libraries.
// Scripts are loaded once and cached; subsequent calls resolve immediately.

const _loaded = new Set<string>();
const _loading = new Map<string, Promise<void>>();

export function loadScript(src: string): Promise<void> {
  if (_loaded.has(src)) return Promise.resolve();
  if (_loading.has(src)) return _loading.get(src)!;

  const p = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.crossOrigin = 'anonymous';
    el.onload = () => { _loaded.add(src); _loading.delete(src); resolve(); };
    el.onerror = () => { _loading.delete(src); reject(new Error(`Failed to load ${src}`)); };
    document.head.appendChild(el);
  });
  _loading.set(src, p);
  return p;
}

let _ortReady: Promise<void> | null = null;
let _pvReady: Promise<void> | null = null;
let _sherpaKwsReady: Promise<void> | null = null;

export function ensureSherpaKwsScripts(): Promise<void> {
  if (_sherpaKwsReady) return _sherpaKwsReady;
  // Set Module.locateFile BEFORE loading the Emscripten JS so the .data preload
  // fetches from /static/ instead of the page root (where Vite serves index.html).
  const W = window as unknown as { Module?: Record<string, unknown> };
  if (!W.Module) W.Module = {};
  W.Module['locateFile'] = (path: string) => '/static/' + path;
  // sherpa-onnx-kws.js (wrapper with createKws) must load BEFORE the WASM bootstrap
  _sherpaKwsReady = loadScript('/static/sherpa-onnx-kws.js')
    .then(() => loadScript('/static/sherpa-onnx-wasm-kws-main.js'));
  return _sherpaKwsReady;
}

/** Load onnxruntime-web (needed for OWW).
 *  Loads from local server to avoid CDN failures on mobile / China networks.
 *  Also sets wasmPaths so WASM binaries load from the same local path. */
function ensureOrt(): Promise<void> {
  if (_ortReady) return _ortReady;
  _ortReady = loadScript('/static/ort.js').then(() => {
    // Point WASM binary loading to local server instead of CDN.
    // Force single-threaded mode because we only bundle non-threaded WASM files
    // (ort-wasm.wasm, ort-wasm-simd.wasm). Without this, browsers with
    // SharedArrayBuffer would try to load ort-wasm-simd-threaded.wasm which
    // does not exist, causing ONNXSessionCannotCreate errors.
    const ort = (window as unknown as { ort?: { env?: { wasm?: { wasmPaths?: string; numThreads?: number; proxy?: boolean } } } }).ort;
    if (ort?.env?.wasm) {
      ort.env.wasm.wasmPaths = '/static/';
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
    }
  });
  return _ortReady;
}

/** Load ort.js + optionally porcupine + web-voice-processor. */
export function ensureWakewordScripts(engine?: string): Promise<void> {
  if (engine === 'openwakeword') return ensureOrt();
  if (engine === 'sherpa-onnx-kws') return ensureSherpaKwsScripts();
  // Picovoice needs all three
  if (_pvReady) return _pvReady;
  _pvReady = Promise.all([
    ensureOrt(),
    loadScript('/static/porcupine-web.js'),
    loadScript('/static/web-voice-processor.js'),
  ]).then(() => {});
  return _pvReady;
}

let _speechSdkReady: Promise<void> | null = null;

/** Load Azure Speech SDK (for browser-direct TTS). */
export function ensureSpeechSdk(): Promise<void> {
  if (_speechSdkReady) return _speechSdkReady;
  _speechSdkReady = loadScript(
    '/static/microsoft.cognitiveservices.speech.sdk.bundle-min.js'
  );
  return _speechSdkReady;
}
