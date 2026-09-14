import * as THREE from 'three';

/**
 * Everything the sky module injects into *other* people's materials:
 * aerial perspective, cloud shadows, and cascaded-shadow selection.
 *
 * None of it edits another module's source. It works by
 *
 *   1. replacing four stock `ShaderChunk`s (`fog_*`) and the directional-light
 *      half of `lights_fragment_begin`, which changes the GLSL for every
 *      material in the process, and
 *   2. walking the scene once per frame and enrolling any material it has not
 *      seen before: a `SKY_AERIAL` define plus a set of *shared* uniform
 *      objects, so one write here updates every material in the city.
 *
 * Materials that are never enrolled fall back to the stock exponential fog
 * driven by `scene.fog`, so a module that creates a material mid-frame gets
 * something sane rather than a black wash.
 *
 * ## Aerial perspective
 *
 * `THREE.Fog` cannot do this: real distance haze is not one grey colour, it is
 * the sky itself leaking in front of the geometry. Here the in-scattered
 * radiance is fetched from the atmosphere's own sky-view LUT *in the direction
 * of the fragment*, so a building seen against the sunset is veiled in orange
 * and the same building seen to the north is veiled in blue, automatically,
 * including the Belt of Venus at twilight.
 *
 * Extinction uses two analytically-integrated exponential layers: a Rayleigh
 * layer with an 8 km scale height, and an aerosol layer with a ~1.1 km scale
 * height whose sea-level coefficient is set from meteorological visual range
 * (sigma = 3.912 / V) rather than the textbook clean-air value, because the
 * boundary layer over a coastal city is not clean air. A Cornette-Shanks lobe
 * adds the forward-scattered glare you get looking into the sun through haze.
 */

const PI = '3.141592653589793';

/** Declarations + the aerial-perspective evaluation, injected into fragments. */
const AERIAL_PARS = /* glsl */ `
#ifdef SKY_AERIAL

  uniform sampler2D uApSkyView;
  uniform vec3  uApSunDir;
  uniform vec3  uApSunColor;
  uniform vec3  uApBetaR;
  uniform vec3  uApBetaM;
  uniform float uApScaleR;
  uniform float uApScaleM;
  uniform float uApViewHeight;   // Mm from the planet centre
  uniform float uApStrength;
  uniform float uApMieG;
  uniform float uApInscatterGain;
  uniform mat3  uApViewToWorld;
  uniform sampler2D uApCloudShadow;
  uniform vec3  uApCloudShadowParams;  // centre.x, centre.z, extent
  uniform float uApCloudShadowOn;

  #define SKY_AP_GROUND 6.360

  float skyApAcos( float x ) { return acos( clamp( x, -1.0, 1.0 ) ); }

  /** Same parameterisation as SKYVIEW_PARAM, duplicated to avoid dragging the
   *  atmosphere's uniform block into every material in the scene. */
  vec2 skyApUv( vec3 rayDir, vec3 sunDir, float viewHeight ) {
    vec3 up = vec3( 0.0, 1.0, 0.0 );
    float horizonAngle = skyApAcos( clamp(
      sqrt( max( viewHeight * viewHeight - SKY_AP_GROUND * SKY_AP_GROUND, 0.0 ) ) / viewHeight, 0.0, 1.0 ) );
    float altitudeAngle = horizonAngle - skyApAcos( dot( rayDir, up ) );
    float azimuth = 0.0;
    if ( abs( altitudeAngle ) <= ( 0.5 * ${PI} - 0.0005 ) ) {
      vec3 rightRaw = cross( sunDir, up );
      float rl = length( rightRaw );
      vec3 right = rl > 1e-4 ? rightRaw / rl : vec3( 1.0, 0.0, 0.0 );
      vec3 forward = cross( up, right );
      vec3 proj = normalize( rayDir - up * dot( rayDir, up ) );
      azimuth = atan( dot( proj, right ), dot( proj, forward ) ) + ${PI};
    }
    float v = 0.5 + 0.5 * sign( altitudeAngle ) * sqrt( abs( altitudeAngle ) * 2.0 / ${PI} );
    return vec2( azimuth / ( 2.0 * ${PI} ), v );
  }

  /** Analytic optical depth of exp(-(y - 0) / H) along a straight segment. */
  float skyApColumn( float y0, float y1, float dist, float scaleH ) {
    float a = exp( -max( y0, -400.0 ) / scaleH );
    float b = exp( -max( y1, -400.0 ) / scaleH );
    float dy = y1 - y0;
    if ( abs( dy ) < 1.0 ) return dist * 0.5 * ( a + b );
    return scaleH * dist / dy * ( a - b );
  }

  float skyApMiePhase( float cosT, float g ) {
    float k = 3.0 / ( 8.0 * ${PI} ) * ( 1.0 - g * g ) / ( 2.0 + g * g );
    float d = 1.0 + g * g - 2.0 * g * cosT;
    return k * ( 1.0 + cosT * cosT ) / ( d * sqrt( max( d, 1e-4 ) ) );
  }

  /** World-space offset from the camera to this fragment. */
  vec3 skyApOffset( vec3 viewPos ) { return uApViewToWorld * viewPos; }

  vec3 skyApply( vec3 color, vec3 viewPos ) {
    vec3 offset = skyApOffset( viewPos );
    float dist = length( offset );
    if ( dist < 1.0 ) return color;
    vec3 rd = offset / dist;

    float y0 = cameraPosition.y;
    float y1 = y0 + offset.y;
    float odR = skyApColumn( y0, y1, dist, uApScaleR );
    float odM = skyApColumn( y0, y1, dist, uApScaleM );

    vec3 tauM = uApBetaM * odM * uApStrength;
    vec3 tau = uApBetaR * odR * uApStrength + tauM;
    vec3 tr = exp( -tau );

    vec3 sky = texture2D( uApSkyView, skyApUv( rd, uApSunDir, uApViewHeight ) ).rgb;
    vec3 inscatter = sky * ( 1.0 - tr ) * uApInscatterGain;

    // Forward-scattered sunlight: the glare that eats a skyline when you look
    // toward a low sun. Without it, haze reads as a flat grey film.
    float cosT = dot( rd, uApSunDir );
    float ph = skyApMiePhase( cosT, uApMieG );
    inscatter += uApSunColor * ph * ( 1.0 - exp( -tauM ) ) * 2.2;

    return color * tr + inscatter;
  }

  /** Fraction of sunlight reaching a world point through the cloud deck. */
  float skyCloudTransmittance( vec3 worldPos ) {
    if ( uApCloudShadowOn < 0.5 ) return 1.0;
    vec2 uv = ( worldPos.xz - uApCloudShadowParams.xy ) / uApCloudShadowParams.z + 0.5;
    vec2 inside = min( uv, 1.0 - uv );
    if ( min( inside.x, inside.y ) <= 0.0 ) return 1.0;
    float edge = smoothstep( 0.0, 0.06, min( inside.x, inside.y ) );
    return mix( 1.0, texture2D( uApCloudShadow, uv ).r, edge );
  }

#endif
`;

const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vFogViewPos;
#endif
`;

const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
  vFogViewPos = mvPosition.xyz;
#endif
`;

const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying vec3 vFogViewPos;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
${AERIAL_PARS}
#endif
`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  #ifdef SKY_AERIAL
    gl_FragColor.rgb = skyApply( gl_FragColor.rgb, vFogViewPos );
  #else
    float vFogDepth = length( vFogViewPos );
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
  #endif
#endif
`;

/** The cascade-selection block spliced into the directional-light loop. */
const CSM_PREAMBLE = /* glsl */ `
	#ifndef CSM_BLEND_SCALE
	#define CSM_BLEND_SCALE 13.0
	#endif
	float csmRemaining = 1.0;
	float csmWeight = 1.0;
	float csmInside = 1.0;
	vec3 csmCoord = vec3( 0.0 );
	vec2 csmEdge = vec2( 0.0 );
	float skyCloudShade = 1.0;
	#if defined( SKY_AERIAL ) && defined( USE_FOG )
	skyCloudShade = skyCloudTransmittance( cameraPosition + skyApOffset( vFogViewPos ) );
	#endif
`;

const CSM_SELECT = /* glsl */ `
		#if ( UNROLLED_LOOP_INDEX + 1 < NUM_DIR_LIGHT_SHADOWS )
			csmCoord = vDirectionalShadowCoord[ i ].xyz / vDirectionalShadowCoord[ i ].w;
			csmEdge = min( csmCoord.xy, 1.0 - csmCoord.xy );
			csmInside = min( csmEdge.x, csmEdge.y );
			csmWeight = min( csmRemaining, clamp( csmInside * CSM_BLEND_SCALE, 0.0, 1.0 ) );
			csmRemaining -= csmWeight;
		#else
			csmWeight = csmRemaining;
		#endif
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		directLight.color *= csmWeight * skyCloudShade;`;

let patched = false;

/**
 * Rewrites the stock chunks. Idempotent, and must run before any material in
 * the scene compiles — i.e. from `Sky.init`, which registration order puts
 * second, right after `Materials`.
 */
export function patchGlobalChunks(): void {
  if (patched) return;
  patched = true;

  THREE.ShaderChunk.fog_pars_vertex = FOG_PARS_VERTEX;
  THREE.ShaderChunk.fog_vertex = FOG_VERTEX;
  THREE.ShaderChunk.fog_pars_fragment = FOG_PARS_FRAGMENT;
  THREE.ShaderChunk.fog_fragment = FOG_FRAGMENT;

  const src = THREE.ShaderChunk.lights_fragment_begin;
  const marker = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )';
  const at = src.indexOf(marker);
  const shadowLine =
    'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ],';
  if (at < 0 || src.indexOf(shadowLine, at) < 0) {
    console.warn('[Sky] lights_fragment_begin has an unexpected shape; CSM blending disabled.');
    return;
  }

  const head = src.slice(0, at);
  let tail = src.slice(at);

  // Declarations go after the DirectionalLightShadow guard, before the loop.
  const loopStart = '\t#pragma unroll_loop_start';
  const loopAt = tail.indexOf(loopStart);
  tail = tail.slice(0, loopAt) + CSM_PREAMBLE + tail.slice(loopAt);

  const lineStart = tail.indexOf(shadowLine);
  const lineEnd = tail.indexOf('\n', lineStart);
  const indentStart = tail.lastIndexOf('\n', lineStart) + 1;
  tail = tail.slice(0, indentStart) + CSM_SELECT.trimStart() + tail.slice(lineEnd);

  THREE.ShaderChunk.lights_fragment_begin = head + tail;
}

export interface AerialUniforms {
  uApSkyView: THREE.IUniform<THREE.Texture | null>;
  uApSunDir: THREE.IUniform<THREE.Vector3>;
  uApSunColor: THREE.IUniform<THREE.Color>;
  uApBetaR: THREE.IUniform<THREE.Vector3>;
  uApBetaM: THREE.IUniform<THREE.Vector3>;
  uApScaleR: THREE.IUniform<number>;
  uApScaleM: THREE.IUniform<number>;
  uApViewHeight: THREE.IUniform<number>;
  uApStrength: THREE.IUniform<number>;
  uApMieG: THREE.IUniform<number>;
  uApInscatterGain: THREE.IUniform<number>;
  uApViewToWorld: THREE.IUniform<THREE.Matrix3>;
  uApCloudShadow: THREE.IUniform<THREE.Texture | null>;
  uApCloudShadowParams: THREE.IUniform<THREE.Vector3>;
  uApCloudShadowOn: THREE.IUniform<number>;
}

/** Rayleigh scattering at sea level, per metre (Bucholtz 1995). */
const BETA_RAYLEIGH = new THREE.Vector3(5.8e-6, 13.56e-6, 33.1e-6);

/**
 * Shared uniform block + the scene sweep that hands it to every material.
 */
export class SceneShading {
  readonly uniforms: AerialUniforms = {
    uApSkyView: { value: null },
    uApSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uApSunColor: { value: new THREE.Color(0, 0, 0) },
    uApBetaR: { value: BETA_RAYLEIGH.clone() },
    uApBetaM: { value: new THREE.Vector3(8e-5, 8e-5, 8e-5) },
    uApScaleR: { value: 8000 },
    uApScaleM: { value: 1150 },
    uApViewHeight: { value: 6.36 },
    uApStrength: { value: 1 },
    uApMieG: { value: 0.72 },
    uApInscatterGain: { value: 1 },
    uApViewToWorld: { value: new THREE.Matrix3() },
    uApCloudShadow: { value: null },
    uApCloudShadowParams: { value: new THREE.Vector3(0, 0, 8000) },
    uApCloudShadowOn: { value: 0 },
  };

  private seen = new WeakSet<THREE.Material>();
  private skipRoots = new Set<THREE.Object3D>();
  private enrolled = 0;
  private sweeps = 0;

  /** Sub-trees left alone entirely (the sky's own geometry and lights). */
  ignore(...roots: THREE.Object3D[]): void {
    for (const r of roots) this.skipRoots.add(r);
  }

  get materialCount(): number {
    return this.enrolled;
  }

  /**
   * Enrols new materials and turns on shadow casting/receiving. Opt out per
   * object with `object.userData.noShadow = true` (water, glass canopies,
   * anything that should not occlude the sun).
   *
   * Swept every frame while the city streams in, then every half second, so a
   * module that builds geometry late still gets haze and shadows.
   */
  sweep(scene: THREE.Scene, force = false): void {
    const warmup = this.sweeps < 150;
    this.sweeps++;
    if (!force && !warmup && this.sweeps % 30 !== 0) return;
    this.walk(scene);
  }

  private walk(obj: THREE.Object3D): void {
    if (this.skipRoots.has(obj)) return;

    const mesh = obj as THREE.Mesh;
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (mat) {
      if (mesh.isMesh && obj.userData.noShadow !== true) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
      if (Array.isArray(mat)) for (const m of mat) this.enrol(m);
      else this.enrol(mat);
    }

    const kids = obj.children;
    for (let i = 0; i < kids.length; i++) this.walk(kids[i]);
  }

  private enrol(material: THREE.Material): void {
    if (this.seen.has(material)) return;
    this.seen.add(material);
    // Materials that opt out of fog opt out of aerial perspective too.
    if ((material as THREE.MeshStandardMaterial).fog === false) return;
    this.enrolled++;

    material.defines = material.defines ?? {};
    (material.defines as Record<string, unknown>).SKY_AERIAL = '';

    const prevCompile = material.onBeforeCompile;
    const uniforms = this.uniforms as unknown as Record<string, THREE.IUniform>;
    material.onBeforeCompile = (shader, renderer) => {
      prevCompile.call(material, shader, renderer);
      for (const key of Object.keys(uniforms)) shader.uniforms[key] = uniforms[key];
    };

    // The default cache key is derived from onBeforeCompile.toString(), but a
    // module that overrode it would otherwise keep serving the unpatched
    // program out of the cache.
    const prevKey = material.customProgramCacheKey.bind(material);
    material.customProgramCacheKey = () => `${prevKey()}|sky-aerial`;
    material.needsUpdate = true;
  }
}
