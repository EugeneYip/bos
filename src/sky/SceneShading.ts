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

/**
 * Asymmetry of the Mie lobe the 256x144 sky-view table can actually resolve,
 * as a fraction of the true one. Scattering past this is present in the table
 * but smeared across its azimuth bins, so the aureole is restored analytically
 * as the difference between the two lobes. Raising it dims the glare around a
 * low sun; lowering it puts the milky sheet back over the whole city.
 */
const LUT_PHASE_G = '0.35';

/**
 * The aerial-perspective evaluation itself, with its own include guard so it
 * can be pasted into a hand-written `ShaderMaterial` as well as spliced into
 * the stock fog chunk. Published on `ctx.aerial` alongside the shared uniform
 * objects, because the modules that need it most — water, and anything else
 * that bypasses `MeshStandardMaterial` — cannot reach this file directly.
 */
export const AERIAL_GLSL = /* glsl */ `
#ifndef SKY_AERIAL_GLSL
#define SKY_AERIAL_GLSL

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
  uniform float uApForwardGain;
  uniform mat3  uApViewToWorld;
  uniform sampler2D uApCloudShadow;
  uniform vec3  uApCloudShadowParams;  // centre.x, centre.z, extent
  uniform float uApCloudShadowOn;

  uniform sampler2D uApLampMap;
  uniform vec4  uApLampRect;     // originX, originZ, 1/width, 1/depth
  uniform vec3  uApLampColor;
  uniform float uApLampStrength; // 0 by day
  uniform float uApLampGroundRange;

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

  /**
   * The sky's own radiance in one direction, straight from the atmosphere's
   * sky-view table — the same table the dome is drawn from, so anything shaded
   * with this converges to exactly the sky behind it instead of to somebody's
   * guess at what that sky looks like.
   *
   * 'rough' widens the sample into a cone the way a rough mirror averages the
   * sky it reflects: a second tap tilted toward the zenith, blended in, which
   * flattens the horizon gradient without a second LUT.
   */
  vec3 skyApRadiance( vec3 dir, float rough ) {
    vec3 a = texture2D( uApSkyView, skyApUv( dir, uApSunDir, uApViewHeight ) ).rgb;
    if ( rough > 0.02 ) {
      vec3 wide = normalize( dir + vec3( 0.0, 1.0, 0.0 ) * rough * 1.7 );
      vec3 b = texture2D( uApSkyView, skyApUv( wide, uApSunDir, uApViewHeight ) ).rgb;
      a = mix( a, b, clamp( rough * 1.25, 0.0, 0.62 ) );
    }
    // The 256x144 table cannot resolve the Mie forward peak, and the aureole
    // around a low sun is most of the glare a wet surface throws back at you.
    float cosT = dot( dir, uApSunDir );
    a += uApSunColor * skyApMiePhase( cosT, mix( 0.80, 0.42, clamp( rough * 2.4, 0.0, 1.0 ) ) )
       * uApInscatterGain * 0.10;
    return a;
  }

  /**
   * Veil 'color' — the radiance leaving a surface 'offset' away in world
   * space — with the air between it and the eye.
   */
  vec3 skyApplyOffset( vec3 color, vec3 offset ) {
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

    // Air-light, not ground light. Below the horizon the sky-view table stops
    // describing the atmosphere and starts describing the planet — its bottom
    // rows are a 0.22-albedo ground term meant for the dome, where a downward
    // ray really does end on the earth. The light scattered *into* a downward
    // path is still sky, so the sample is lifted above the horizon. Without
    // any lift the far hills darken as the camera climbs, which is backwards.
    //
    // It is lifted clear of the horizon rather than onto it. The row at y=0
    // is the boundary between the atmosphere rows and the ground rows, and it
    // still carries some of that 0.22-albedo term -- so reading it made the
    // air-light along a downward path too bright, and distant ground came out
    // brighter than the city in front of it. Measured over the high aerial
    // frame: the far field was 135.8 mean luma against 89.4 for the modelled
    // city, and at a standard deviation of 8.1 it was flat enough to read as
    // painted backdrop rather than land.
    //
    // Sampling 0.045 above the horizon instead takes the far field to 131.6
    // and its detail from 8.1 to 9.8, and -- because this term veils
    // everything, not only the far field -- the city's own contrast from 34.6
    // to 39.6. That last number is the one that matters: it is a 14% gain in
    // definition across the whole frame for one clamp.
    //
    // Checked against the alternatives before settling here. Halving the
    // optical depth gives more contrast again (far field 11.5, city 40.2) but
    // it is a lie: the Mie coefficient is set from a 49 km meteorological
    // visual range, which is what a clear day over the harbour actually is,
    // and halving it claims 98 km. Cutting `uApInscatterGain` to 0.65 lands in
    // much the same place as this does, but as an unexplained factor rather
    // than a fix to a known contamination.
    vec3 rdSky = rd.y < 0.045 ? normalize( vec3( rd.x, 0.045, rd.z ) ) : rd;
    vec3 sky = texture2D( uApSkyView, skyApUv( rdSky, uApSunDir, uApViewHeight ) ).rgb;
    vec3 inscatter = sky * ( 1.0 - tr ) * uApInscatterGain;

    // Forward-scattered sunlight: the glare that eats a skyline when you look
    // toward a low sun.
    //
    // The sky-view table already carries Mie single scattering, so this cannot
    // simply add another copy of it -- at long range '1 - exp(-tauM)' goes to
    // one and the copy arrives at full strength everywhere, which reads as a
    // milky sheet over the whole city on a 49 km-visibility day. What the table
    // actually misses is the forward peak: 256x144 bins average the aureole
    // away. So add only the deficit, the true phase function minus the blunt
    // lobe the table can resolve. It peaks on the sun's axis and reaches zero
    // by ~35 degrees off it, which is where the real aureole ends too.
    float cosT = dot( rd, uApSunDir );
    float ph = skyApMiePhase( cosT, uApMieG );
    float phLut = skyApMiePhase( cosT, uApMieG * ${LUT_PHASE_G} );
    inscatter += uApSunColor * max( ph - phLut, 0.0 )
       * ( 1.0 - exp( -tauM ) ) * uApForwardGain;

    return color * tr + inscatter;
  }

  /** World-space offset from the camera to this fragment. */
  vec3 skyApOffset( vec3 viewPos ) { return uApViewToWorld * viewPos; }

  vec3 skyApply( vec3 color, vec3 viewPos ) {
    return skyApplyOffset( color, skyApOffset( viewPos ) );
  }

  /**
   * Irradiance from Boston's street lighting.
   *
   * Ten thousand lamps cannot each be a light — three would need a clustered
   * or deferred path for that, and this renderer is neither. But their *pools*
   * are a static, purely positional quantity, so the props module splats them
   * once into a field over the city and every material in the scene reads it
   * with one fetch, the same way the cloud shadow works.
   *
   * Two things make it read as lighting rather than as a painted-on glow:
   *
   *  - **Height.** The field's second channel carries the elevation of the
   *    ground the lamps stand on, so the pool thins as a facade climbs out of
   *    it. Without that, Beacon Hill's rooftops would be as lit as its
   *    pavements, and absolute Y cannot be used because the city is not flat.
   *  - **Direction.** A lamp is overhead, so the road takes nearly all of it
   *    and a wall takes about half. The wrap keeps the shaded side of a bollard
   *    from going black, which is what actually happens under a diffuse pool.
   */
  vec3 skyStreetLight( vec3 worldPos, vec3 n ) {
    if ( uApLampStrength < 0.001 ) return vec3( 0.0 );
    vec2 uv = ( worldPos.xz - uApLampRect.xy ) * uApLampRect.zw;
    vec2 inside = min( uv, 1.0 - uv );
    if ( min( inside.x, inside.y ) <= 0.0 ) return vec3( 0.0 );

    vec2 field = texture2D( uApLampMap, uv ).rg;
    float pool = field.r;
    if ( pool <= 0.0 ) return vec3( 0.0 );

    // Lamp heads sit 4-9 m up. Full strength at the pavement, gone by the
    // fourth floor; below the reference the light is still arriving, so only
    // the climb is penalised.
    float above = max( worldPos.y - ( field.g * uApLampGroundRange - 8.0 ), 0.0 );
    float fall = 1.0 / ( 1.0 + above * above * 0.010 );

    float facing = clamp( n.y * 0.45 + 0.55, 0.0, 1.0 );
    return uApLampColor * ( pool * uApLampStrength * fall * facing );
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

/** Declarations + the aerial-perspective evaluation, injected into fragments. */
const AERIAL_PARS = /* glsl */ `
#ifdef SKY_AERIAL
${AERIAL_GLSL}
#endif
`;

/**
 * Appended to the indirect-light gather. It has to run there and not on
 * `gl_FragColor`: street lighting is light, so it has to be multiplied by the
 * surface's own albedo, not added over the top of it.
 *
 * `fog_pars_fragment` is included before `lights_pars_begin` in three's
 * fragment template, so the declarations above are already in scope here — the
 * same reason the cascade preamble can call `skyCloudTransmittance`.
 */
const LIGHTS_MAPS = /* glsl */ `
#if defined( RE_IndirectDiffuse ) && defined( SKY_AERIAL ) && defined( USE_FOG )
	irradiance += skyStreetLight( cameraPosition + skyApOffset( vFogViewPos ), geometryNormal );
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
  // Appended to the stock text, not an `#include` of it: a chunk that includes
  // itself makes three's include resolver recurse until the stack goes.
  THREE.ShaderChunk.lights_fragment_maps += LIGHTS_MAPS;

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
  uApForwardGain: THREE.IUniform<number>;
  uApViewToWorld: THREE.IUniform<THREE.Matrix3>;
  uApCloudShadow: THREE.IUniform<THREE.Texture | null>;
  uApCloudShadowParams: THREE.IUniform<THREE.Vector3>;
  uApCloudShadowOn: THREE.IUniform<number>;
  uApLampMap: THREE.IUniform<THREE.Texture | null>;
  uApLampRect: THREE.IUniform<THREE.Vector4>;
  uApLampColor: THREE.IUniform<THREE.Color>;
  uApLampStrength: THREE.IUniform<number>;
  uApLampGroundRange: THREE.IUniform<number>;
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
    uApForwardGain: { value: 1 },
    uApViewToWorld: { value: new THREE.Matrix3() },
    uApCloudShadow: { value: null },
    uApCloudShadowParams: { value: new THREE.Vector3(0, 0, 8000) },
    uApCloudShadowOn: { value: 0 },
    uApLampMap: { value: null },
    uApLampRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    // Boston finished converting its street lighting to LED in 2019: 4000 K on
    // the arterials, 3000 K on residential streets. Not sodium — at 2700 K the
    // tarmac came out pure orange with no blue in it at all.
    uApLampColor: { value: new THREE.Color(1.0, 0.89, 0.76) },
    uApLampStrength: { value: 0 },
    uApLampGroundRange: { value: 80 },
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
   * Enrols new materials and turns on shadow casting/receiving.
   *
   * Receiving is unconditional — every lit surface in the city wants it, and
   * it costs nothing on a material that has no lights. *Casting* is opt-out,
   * via `object.userData.noShadow = true`, because it is not free and because
   * some surfaces must not do it at all: a flat ground polygon drawn
   * `DoubleSide` writes its own front faces into the shadow map (three maps
   * `DoubleSide` to `DoubleSide` for the depth pass rather than to `BackSide`)
   * and then fails the comparison against itself. Boston Common rendered
   * black for exactly that reason, while the terrain one centimetre beneath it
   * was correctly lit and correctly dappled.
   *
   * The flag is the only channel that works: `castShadow` defaults to false,
   * so a module setting it false at construction is indistinguishable from one
   * that never thought about it, and this sweep cannot tell them apart.
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
      if (mesh.isMesh) {
        mesh.receiveShadow = true;
        if (obj.userData.noShadow !== true) mesh.castShadow = true;
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
