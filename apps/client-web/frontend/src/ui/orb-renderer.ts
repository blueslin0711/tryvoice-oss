// WebGL Liquid Orb renderer for car mode
// Dynamically imports Three.js only when car mode is entered

import { bus } from '../core/event-bus';
type OrbAppState = 'idle' | 'recording' | 'processing' | 'speaking';

interface OrbStateParams {
  noiseAmp: number;
  noiseFreq: number;
  pulseSpeed: number;
  color: [number, number, number]; // RGB normalized 0-1
}

const STATE_PARAMS: Record<string, OrbStateParams> = {
  idle:       { noiseAmp: 0.03, noiseFreq: 1.5, pulseSpeed: 0.8, color: [0.122, 0.525, 1.0] },   // #1f86ff
  recording:  { noiseAmp: 0.08, noiseFreq: 3.0, pulseSpeed: 2.0, color: [0.922, 0.302, 0.294] },  // #eb4d4b
  processing: { noiseAmp: 0.02, noiseFreq: 1.0, pulseSpeed: 0.5, color: [0.961, 0.651, 0.137] },  // #f5a623
  speaking:   { noiseAmp: 0.05, noiseFreq: 2.5, pulseSpeed: 1.5, color: [0.133, 0.710, 0.451] },  // #22b573
};

// Use `any` for Three.js types since we dynamically import
let _renderer: any = null;
let _scene: any = null;
let _camera: any = null;
let _mesh: any = null;
let _material: any = null;
let _clock: any = null;
let _raf = 0;
let _rms = 0;
let _targetParams: OrbStateParams = STATE_PARAMS.idle;
let _currentParams: OrbStateParams = { ...STATE_PARAMS.idle };
let _destroyed = false;
let _canvas: HTMLCanvasElement | null = null;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

async function _initThree(canvas: HTMLCanvasElement): Promise<void> {
  const THREE = await import('three');
  const { vertexShader, fragmentShader } = await import('./orb-shaders');

  _clock = new THREE.Clock();

  _renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  _renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  _renderer.setClearColor(0x000000, 0);

  _scene = new THREE.Scene();

  _camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  _camera.position.z = 3;

  const geometry = new THREE.IcosahedronGeometry(1, 64);

  _material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      u_time: { value: 0 },
      u_rms: { value: 0 },
      u_noiseAmp: { value: _currentParams.noiseAmp },
      u_noiseFreq: { value: _currentParams.noiseFreq },
      u_pulseSpeed: { value: _currentParams.pulseSpeed },
      u_colorA: { value: new THREE.Vector3(..._currentParams.color) },
      u_colorB: { value: new THREE.Vector3(..._currentParams.color) },
      u_stateBlend: { value: 0 },
    },
    transparent: true,
  });

  _mesh = new THREE.Mesh(geometry, _material);
  _scene.add(_mesh);

  _resize(canvas);
}

function _resize(canvas: HTMLCanvasElement): void {
  if (!_renderer || !_camera) return;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  if (w === 0 || h === 0) return;
  _renderer.setSize(w, h, false);
  _camera.aspect = w / h;
  _camera.updateProjectionMatrix();
}

function _animate(): void {
  if (_destroyed) return;

  const dt = _clock?.getDelta() || 0.016;
  const lerpSpeed = 4.0 * dt; // smooth transition ~250ms

  // Lerp current params toward target
  _currentParams.noiseAmp = lerp(_currentParams.noiseAmp, _targetParams.noiseAmp, lerpSpeed);
  _currentParams.noiseFreq = lerp(_currentParams.noiseFreq, _targetParams.noiseFreq, lerpSpeed);
  _currentParams.pulseSpeed = lerp(_currentParams.pulseSpeed, _targetParams.pulseSpeed, lerpSpeed);
  _currentParams.color[0] = lerp(_currentParams.color[0], _targetParams.color[0], lerpSpeed);
  _currentParams.color[1] = lerp(_currentParams.color[1], _targetParams.color[1], lerpSpeed);
  _currentParams.color[2] = lerp(_currentParams.color[2], _targetParams.color[2], lerpSpeed);

  // Update uniforms
  if (_material) {
    const u = _material.uniforms;
    u.u_time.value = _clock.getElapsedTime();
    u.u_rms.value = lerp(u.u_rms.value, _rms, 8.0 * dt); // fast RMS tracking
    u.u_noiseAmp.value = _currentParams.noiseAmp;
    u.u_noiseFreq.value = _currentParams.noiseFreq;
    u.u_pulseSpeed.value = _currentParams.pulseSpeed;
    u.u_colorA.value.set(..._currentParams.color);
  }

  if (_renderer && _scene && _camera) {
    _renderer.render(_scene, _camera);
  }

  _raf = requestAnimationFrame(_animate);
}

export function setOrbState(state: OrbAppState): void {
  _targetParams = STATE_PARAMS[state] || STATE_PARAMS.idle;
}

export function setOrbRms(rms: number): void {
  _rms = Math.min(rms / 0.15, 1);
}

function _onResize(): void {
  if (_canvas) _resize(_canvas);
}

export async function startOrb(canvas: HTMLCanvasElement): Promise<void> {
  _destroyed = false;
  _rms = 0;
  _canvas = canvas;
  _currentParams = { ...STATE_PARAMS.idle };
  _targetParams = STATE_PARAMS.idle;

  await _initThree(canvas);
  _animate();

  // Listen for state changes and RMS
  bus.on('app:state', _onState);
  bus.on('audio:tts-rms', _onTtsRms);
  bus.on('recording:rms', _onRecordingRms);
  window.addEventListener('resize', _onResize);
}

export function stopOrb(): void {
  _destroyed = true;
  _canvas = null;
  if (_raf) { cancelAnimationFrame(_raf); _raf = 0; }
  bus.off('app:state', _onState);
  bus.off('audio:tts-rms', _onTtsRms);
  bus.off('recording:rms', _onRecordingRms);
  window.removeEventListener('resize', _onResize);

  if (_mesh) {
    _mesh.geometry?.dispose();
    _mesh = null;
  }
  if (_material) { _material.dispose(); _material = null; }
  if (_renderer) { _renderer.dispose(); _renderer = null; }
  _scene = null;
  _camera = null;
  _clock = null;
}

function _onState(state: unknown): void {
  setOrbState(state as OrbAppState);
}

function _onTtsRms(rms: unknown): void {
  setOrbRms(rms as number);
}

function _onRecordingRms(rms: unknown): void {
  setOrbRms(rms as number);
}
