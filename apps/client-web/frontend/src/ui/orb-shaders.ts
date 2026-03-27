// GLSL shaders for the liquid Orb

export const vertexShader = /* glsl */ `
  uniform float u_time;
  uniform float u_rms;
  uniform float u_noiseAmp;
  uniform float u_noiseFreq;
  uniform float u_pulseSpeed;

  varying vec3 vNormal;
  varying vec3 vPosition;
  varying float vDisplacement;

  // Simplex 3D noise
  vec4 permute(vec4 x) { return mod(((x*34.0)+1.0)*x, 289.0); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod(i, 289.0);
    vec4 p = permute(permute(permute(
              i.z + vec4(0.0, i1.z, i2.z, 1.0))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 1.0/7.0;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }

  void main() {
    float t = u_time * u_pulseSpeed;

    // Multi-octave noise displacement
    float n1 = snoise(position * u_noiseFreq + t * 0.3);
    float n2 = snoise(position * u_noiseFreq * 2.0 + t * 0.5) * 0.5;
    float noise = n1 + n2;

    // Breathing pulse
    float breathe = sin(t) * 0.02;

    // RMS-driven amplitude boost
    float rmsBoost = u_rms * 0.15;

    float displacement = noise * (u_noiseAmp + rmsBoost) + breathe;
    vec3 newPos = position + normal * displacement;

    vNormal = normalize(normalMatrix * normal);
    vPosition = newPos;
    vDisplacement = displacement;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(newPos, 1.0);
  }
`;

export const fragmentShader = /* glsl */ `
  uniform vec3 u_colorA;
  uniform vec3 u_colorB;
  uniform float u_stateBlend;
  uniform float u_time;
  uniform float u_rms;

  varying vec3 vNormal;
  varying vec3 vPosition;
  varying float vDisplacement;

  void main() {
    // Fresnel rim glow
    vec3 viewDir = normalize(cameraPosition - vPosition);
    float fresnel = pow(1.0 - max(dot(vNormal, viewDir), 0.0), 2.5);

    // Base color interpolated by state blend
    vec3 baseColor = mix(u_colorA, u_colorB, u_stateBlend);

    // Displacement-driven color variation
    vec3 displaceColor = baseColor + vDisplacement * 1.5;

    // Combine with fresnel rim
    vec3 rimColor = vec3(1.0) * 0.6;
    vec3 finalColor = mix(displaceColor, rimColor, fresnel * 0.5);

    // Subtle inner glow
    float innerGlow = 0.08 + u_rms * 0.15;
    finalColor += baseColor * innerGlow;

    float alpha = 0.85 + fresnel * 0.15;
    gl_FragColor = vec4(finalColor, alpha);
  }
`;
