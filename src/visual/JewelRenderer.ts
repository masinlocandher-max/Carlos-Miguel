import * as THREE from 'three';
import type { JewelState } from '../lib/model';
import { parameters, blendParameters } from './parameters';
import { createDevelopmentGeometry } from './developmentGeometry';
const GOLD = 0xc8a15e;
const pointVertex = `
attribute vec2 illumination;
attribute float seed;
uniform float time, eyes, density, brightness, pixelRatio, motion, audioAmplitude;
varying float intensity;
varying float warmth;
void main(){
 float l=mix(illumination.x, illumination.y, eyes);
 float alive=1.0-smoothstep(density-.05,density+.02,seed);
 float shimmer=1.0+.10*sin(time*.65+seed*40.0)*motion;
 float lowerFace=exp(-pow((position.y+.13)*8.0,2.0));
 vec3 p=position;
 p.z+=sin(time*.7+seed*50.0)*.006*motion;
 p.x+=sin(time*.3+seed*31.0)*.0007*motion;
 intensity=pow(l,1.25)*alive*brightness*shimmer*4.2;
 intensity*=1.0+audioAmplitude*lowerFace*.22;
 warmth=l;
 gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
 gl_PointSize=(1.25+pow(l,1.2)*.8+step(.995,seed)*1.5)*pixelRatio;
}`;
const pointFragment = `
varying float intensity; varying float warmth;
void main(){vec2 p=gl_PointCoord-.5;float r=length(p);if(r>.5)discard;
float a=exp(-r*r*15.0)*intensity;
vec3 color=mix(vec3(.86,.51,.18),vec3(1.0,.88,.63),warmth);
gl_FragColor=vec4(color,a);}`;
const streamVertex = `
attribute float seed;uniform float phase, time, activity, pixelRatio;varying float intensity;
void main(){
 float angle=seed*62.83185+phase*(.6+mod(seed*11.0,2.0));
 float radius=1.04+mod(seed*13.0,1.0)*.45;
 vec3 p=vec3(cos(angle)*radius,sin(angle)*radius*.29,sin(angle)*.19);
 p.y+=sin(seed*51.0)*.19;
 intensity=(.12+activity*.7)*(1.0-smoothstep(.55+activity*.45,1.0,seed));
 gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
 gl_PointSize=(1.4+step(.94,seed)*2.8)*pixelRatio;
}`;
const streamFragment = `varying float intensity;void main(){float r=length(gl_PointCoord-.5);if(r>.5)discard;gl_FragColor=vec4(1.0,.71,.28,exp(-r*r*16.0)*intensity);}`;
export type CoreController = {
  setState: (state: JewelState) => void;
  setAudioAmplitude: (value: number) => void;
  dispose: () => void;
};
export async function createJewelRenderer(
  host: HTMLDivElement,
  initialState: JewelState,
  signal: AbortSignal,
): Promise<CoreController> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const { values, filamentValues } = createDevelopmentGeometry();
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: false,
      powerPreference: 'high-performance',
    });
  } catch {
    return createCanvasFallback(host, values, initialState, signal);
  }
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.domElement.setAttribute('aria-label', 'Live Jewel particle hologram');
  renderer.domElement.setAttribute('role', 'img');
  host.appendChild(renderer.domElement);
  host.dataset.renderer = 'webgl';
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 20);
  camera.position.z = 5;
  const core = new THREE.Group();
  scene.add(core);
  const count = values.length / 6,
    positions = new Float32Array(count * 3),
    lights = new Float32Array(count * 2),
    seeds = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions.set(values.subarray(i * 6, i * 6 + 3), i * 3);
    lights.set(values.subarray(i * 6 + 3, i * 6 + 5), i * 2);
    seeds[i] = values[i * 6 + 5];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('illumination', new THREE.BufferAttribute(lights, 2));
  geometry.setAttribute('seed', new THREE.BufferAttribute(seeds, 1));
  const uniforms = {
    time: { value: 0 },
    eyes: { value: 0 },
    density: { value: 0.64 },
    brightness: { value: 0.75 },
    pixelRatio: { value: renderer.getPixelRatio() },
    motion: { value: 1 },
    audioAmplitude: { value: 0 },
  };
  const order = Array.from({ length: count }, (_, i) => i);
  let randomSeed = 41;
  for (let i = count - 1; i > 0; i--) {
    randomSeed = (Math.imul(randomSeed, 1664525) + 1013904223) >>> 0;
    const j = randomSeed % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  geometry.setIndex(order);
  const material = new THREE.ShaderMaterial({
    vertexShader: pointVertex,
    fragmentShader: pointFragment,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  core.add(new THREE.Points(geometry, material));
  const glowMaterial = new THREE.ShaderMaterial({
    vertexShader: pointVertex.replace(')*pixelRatio;', ')*pixelRatio*3.8;'),
    fragmentShader: pointFragment.replace('vec4(color,a)', 'vec4(color,a*.042)'),
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const glowPoints = new THREE.Points(geometry, glowMaterial);
  core.add(glowPoints);
  // Sparse spatial filaments connect neutral development vertices.
  const wireVertices: number[] = [];
  for (let i = 0; i < count - 24; i += 11) {
    const j = i + (i % 3 === 0 ? 1 : 17);
    const dx = positions[i * 3] - positions[j * 3],
      dy = positions[i * 3 + 1] - positions[j * 3 + 1];
    if (dx * dx + dy * dy < 0.004 && lights[i * 2] > 0.16) {
      wireVertices.push(
        ...positions.subarray(i * 3, i * 3 + 3),
        ...positions.subarray(j * 3, j * 3 + 3),
      );
    }
  }
  const wireGeometry = new THREE.BufferGeometry();
  wireGeometry.setAttribute('position', new THREE.Float32BufferAttribute(wireVertices, 3));
  const wireMaterial = new THREE.LineBasicMaterial({
    color: GOLD,
    transparent: true,
    opacity: 0.1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  core.add(new THREE.LineSegments(wireGeometry, wireMaterial));
  const contourGeometry = new THREE.BufferGeometry();
  contourGeometry.setAttribute('position', new THREE.BufferAttribute(filamentValues, 3));
  const contourMaterial = new THREE.LineBasicMaterial({
    color: 0xeebd78,
    transparent: true,
    opacity: 0.34,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  core.add(new THREE.LineSegments(contourGeometry, contourMaterial));
  const rings: THREE.LineSegments[] = [];
  for (let k = 0; k < 9; k++) {
    const coords: number[] = [];
    const radius = 1.06 + k * 0.035;
    for (let i = 0; i < 300; i++) {
      if (k % 3 === 0 && i % 24 > 17) continue;
      if (k % 3 === 1 && i % 3 === 0) continue;
      const a = (i / 300) * Math.PI * 2,
        b = ((i + 0.72) / 300) * Math.PI * 2;
      coords.push(
        Math.cos(a) * radius,
        Math.sin(a) * radius,
        0,
        Math.cos(b) * radius,
        Math.sin(b) * radius,
        0,
      );
      if (k === 2 && i % 5 === 0)
        coords.push(
          Math.cos(a) * (radius - 0.025),
          Math.sin(a) * (radius - 0.025),
          0,
          Math.cos(a) * (radius + 0.004),
          Math.sin(a) * (radius + 0.004),
          0,
        );
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(coords, 3));
    const m = new THREE.LineBasicMaterial({
      color: k % 2 ? 0xb78032 : 0xe5bc76,
      transparent: true,
      opacity: k < 3 ? 0.5 : 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ring = new THREE.LineSegments(g, m);
    ring.position.y = 0.01;
    core.add(ring);
    rings.push(ring);
  }
  const bands = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const band = new THREE.Mesh(
      new THREE.RingGeometry(1.105, 1.124, 64, 1, (i * Math.PI) / 3 + 0.05, 0.73),
      new THREE.MeshBasicMaterial({
        color: 0xe8b764,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    bands.add(band);
  }
  core.add(bands);
  const beaconGeometry = new THREE.BufferGeometry();
  beaconGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [0, 1.19, 0.03, 0, -1.19, 0.03, -1.19, 0, 0.03, 1.19, 0, 0.03],
      3,
    ),
  );
  const beaconMaterial = new THREE.ShaderMaterial({
    uniforms: { pixelRatio: { value: renderer.getPixelRatio() } },
    vertexShader: `uniform float pixelRatio;void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);gl_PointSize=28.0*pixelRatio;}`,
    fragmentShader: `void main(){vec2 p=gl_PointCoord-.5;float r=length(p);float halo=exp(-r*r*38.0)*.5;float core=exp(-r*r*650.0);gl_FragColor=vec4(1.0,.70,.25,halo+core);}`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  core.add(new THREE.Points(beaconGeometry, beaconMaterial));
  const orbits: THREE.Line[] = [];
  for (let k = 0; k < 4; k++) {
    const coords = [];
    for (let i = 0; i <= 200; i++) {
      const a = (i / 200) * Math.PI * 2;
      coords.push(
        new THREE.Vector3(
          Math.cos(a) * (1.43 + k * 0.065),
          Math.sin(a) * (0.16 + k * 0.065),
          Math.sin(a) * 0.14,
        ),
      );
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(coords),
      new THREE.LineBasicMaterial({
        color: GOLD,
        transparent: true,
        opacity: 0.13,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    line.rotation.z = (k - 1.5) * 0.08;
    core.add(line);
    orbits.push(line);
  }
  const streamGeometry = new THREE.BufferGeometry(),
    streamCount = 420;
  streamGeometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(streamCount * 3), 3),
  );
  streamGeometry.setAttribute(
    'seed',
    new THREE.Float32BufferAttribute(
      Array.from({ length: streamCount }, (_, i) => i / streamCount),
      1,
    ),
  );
  const streamUniforms = {
    phase: { value: 0 },
    time: { value: 0 },
    activity: { value: 0.1 },
    pixelRatio: { value: renderer.getPixelRatio() },
  };
  const streamMaterial = new THREE.ShaderMaterial({
    vertexShader: streamVertex,
    fragmentShader: streamFragment,
    uniforms: streamUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const streams = new THREE.Points(streamGeometry, streamMaterial);
  streams.frustumCulled = false;
  core.add(streams);
  const scanGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-0.76, 0, 0.24),
    new THREE.Vector3(0.76, 0, 0.24),
  ]);
  const scanMaterial = new THREE.LineBasicMaterial({
    color: 0xeac385,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const scan = new THREE.Line(scanGeometry, scanMaterial);
  core.add(scan);
  const pulseMaterial = new THREE.LineBasicMaterial({
    color: 0xffd394,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const pulse = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      Array.from(
        { length: 180 },
        (_, i) =>
          new THREE.Vector3(
            Math.cos((i / 180) * Math.PI * 2) * 1.1,
            Math.sin((i / 180) * Math.PI * 2) * 1.1,
            0,
          ),
      ),
    ),
    pulseMaterial,
  );
  core.add(pulse);
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = media.matches;
  let state = initialState,
    current = { ...parameters[initialState] },
    frame = 0,
    last = 0,
    elapsed = 0,
    phase = 0,
    disposed = false,
    pulseStart = -100,
    audio = 0,
    slowFrames = 0,
    frameCount = 0,
    lodQuality = 1,
    viewScale = 1,
    lost = false;
  const resize = () => {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    viewScale = Math.min(1, width / 1152);
    geometry.setDrawRange(
      0,
      Math.max(1500, Math.floor(count * viewScale * viewScale * lodQuality)),
    );
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  resize();
  const updateReduced = () => {
    reduced = media.matches;
  };
  media.addEventListener('change', updateReduced);
  const animate = (now: number) => {
    if (disposed || lost || document.hidden) return;
    frame = requestAnimationFrame(animate);
    const raw = last ? (now - last) / 1000 : 1 / 60;
    if (reduced && raw < 1 / 12) return;
    const dt = Math.min(raw, 0.1);
    last = now;
    elapsed += dt;
    blendParameters(current, parameters[state], dt);
    if (!reduced) phase += dt * current.speed;
    uniforms.time.value = elapsed;
    uniforms.eyes.value = current.eyes;
    uniforms.density.value = current.density;
    uniforms.brightness.value =
      current.brightness * (reduced ? 1 : 1 + Math.sin(elapsed * 0.75) * 0.035);
    uniforms.motion.value = reduced ? 0 : 1;
    uniforms.audioAmplitude.value = audio;
    wireMaterial.opacity = 0.2 + current.speed * 0.18;
    contourMaterial.opacity = (0.36 + current.speed * 0.1) * Math.sqrt(viewScale);
    if (!reduced) bands.rotation.z += dt * current.speed * 0.035;
    rings.forEach((ring, i) => {
      if (!reduced)
        ring.rotation.z += dt * current.speed * 0.12 * (i % 2 ? -1 : 1) * (1 + i * 0.05);
      (ring.material as THREE.LineBasicMaterial).opacity =
        THREE.MathUtils.clamp(current.rings - i, 0, 1) *
        (i % 3 === 0 ? 0.82 : 0.5) *
        (1 + audio * 0.1);
    });
    orbits.forEach((orbit, i) => {
      (orbit.material as THREE.LineBasicMaterial).opacity =
        (0.22 + current.speed * 0.16) * THREE.MathUtils.clamp(current.rings - 2 - i, 0, 1);
    });
    streamUniforms.phase.value = phase;
    streamUniforms.time.value = elapsed;
    streamUniforms.activity.value = current.speed;
    scan.position.y = reduced ? 0 : Math.sin(phase * 0.8) * 0.78;
    scanMaterial.opacity = reduced ? 0 : current.scan * 0.1 * Math.pow(Math.sin(elapsed * 0.7), 8);
    const pulseAge = elapsed - pulseStart;
    const activePulse = pulseAge >= 0 && pulseAge < 2.2;
    const outward = activePulse ? pulseAge / 2.2 : 0;
    pulse.scale.setScalar(reduced ? 1 : 1 + outward * 0.28);
    pulseMaterial.opacity = activePulse ? Math.sin(outward * Math.PI) * 0.65 : 0;
    if (state === 'executing' && !activePulse && elapsed - pulseStart > 4.5) pulseStart = elapsed;
    core.rotation.y = reduced ? 0 : Math.sin(elapsed * 0.13) * current.depth;
    core.rotation.x = reduced ? 0 : Math.sin(elapsed * 0.1) * current.depth * 0.4;
    renderer.render(scene, camera);
    // Reduce fill cost only after a sustained run of slow frames.
    if (!reduced && ++frameCount < 120 && raw > 0.026) slowFrames++;
    if (frameCount === 120 && slowFrames > 45) {
      renderer.setPixelRatio(0.75);
      uniforms.pixelRatio.value = 0.75;
      streamUniforms.pixelRatio.value = 0.75;
      beaconMaterial.uniforms.pixelRatio.value = 0.75;
      glowPoints.visible = false;
      lodQuality = 0.7;
      resize();
    }
  };
  const visibility = () => {
    cancelAnimationFrame(frame);
    if (!document.hidden && !disposed && !lost) {
      last = 0;
      frame = requestAnimationFrame(animate);
    }
  };
  document.addEventListener('visibilitychange', visibility);
  let fallback: CoreController | undefined;
  const contextLost = (event: Event) => {
    event.preventDefault();
    if (lost) return;
    lost = true;
    cancelAnimationFrame(frame);
    renderer.domElement.style.display = 'none';
    fallback = createCanvasFallback(host, values, state, signal);
  };
  renderer.domElement.addEventListener('webglcontextlost', contextLost);
  frame = requestAnimationFrame(animate);
  return {
    setState(next) {
      if (state !== next && (next === 'complete' || next === 'listening')) pulseStart = elapsed;
      state = next;
      fallback?.setState(next);
    },
    setAudioAmplitude(value) {
      audio = THREE.MathUtils.clamp(value, 0, 1);
      fallback?.setAudioAmplitude(audio);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      media.removeEventListener('change', updateReduced);
      renderer.domElement.removeEventListener('webglcontextlost', contextLost);
      fallback?.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Points || obj instanceof THREE.Line || obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
          materials.forEach((m) => m.dispose());
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
// Live lower-motion fallback using the same neutral procedural geometry.
function createCanvasFallback(
  host: HTMLDivElement,
  values: Float32Array,
  initial: JewelState,
  signal: AbortSignal,
): CoreController {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Live Jewel particle hologram, reduced rendering');
  host.append(canvas);
  host.dataset.renderer = 'canvas';
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  let state = initial,
    current = { ...parameters[initial] },
    frame = 0,
    last = 0,
    elapsed = 0,
    disposed = false;
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  const resize = () => {
    canvas.width = host.clientWidth;
    canvas.height = host.clientHeight;
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  const render = (now: number) => {
    if (disposed || signal.aborted || document.hidden) return;
    frame = requestAnimationFrame(render);
    const raw = last ? (now - last) / 1000 : 1 / 30;
    if (raw < (media.matches ? 1 / 10 : 1 / 30)) return;
    last = now;
    const dt = Math.min(raw, 0.1);
    elapsed += dt;
    blendParameters(current, parameters[state], dt);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scale = canvas.height / 2.679,
      cx = canvas.width / 2,
      cy = canvas.height / 2;
    ctx.fillStyle = '#e9b363';
    for (let i = 0; i < values.length; i += 18) {
      const seed = values[i + 5];
      if (seed > current.density) continue;
      const light = values[i + 3] * (1 - current.eyes) + values[i + 4] * current.eyes;
      ctx.globalAlpha = Math.pow(light, 1.4) * current.brightness * 0.8;
      ctx.fillRect(cx + values[i] * scale, cy - values[i + 1] * scale, 1.25, 1.25);
    }
    ctx.strokeStyle = '#c8a15e';
    ctx.lineWidth = 0.65;
    for (let r = 0; r < 9; r++) {
      ctx.globalAlpha = Math.max(0, Math.min(1, current.rings - r)) * 0.35;
      ctx.beginPath();
      const start = media.matches ? 0 : elapsed * 0.015 * current.speed * (r % 2 ? -1 : 1);
      ctx.arc(cx, cy, (1.06 + r * 0.035) * scale, start, start + Math.PI * 1.84);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 1.5 * scale, 0.19 * scale, 0, 0, Math.PI * 2);
    ctx.stroke();
    if (!media.matches) {
      const a = elapsed * current.speed;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * 1.5 * scale, cy + Math.sin(a) * 0.19 * scale, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };
  const visibility = () => {
    cancelAnimationFrame(frame);
    if (!document.hidden) {
      last = 0;
      frame = requestAnimationFrame(render);
    }
  };
  document.addEventListener('visibilitychange', visibility);
  frame = requestAnimationFrame(render);
  return {
    setState(next) {
      state = next;
    },
    setAudioAmplitude() {},
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      canvas.remove();
    },
  };
}
