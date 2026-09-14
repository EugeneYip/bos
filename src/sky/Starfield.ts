import * as THREE from 'three';
import { starCatalogue } from './sky-data/stars';
import { blackbodyToLinearRGB, bvToKelvin } from './util';
import { NOISE_GLSL } from './shaders/noise';

/**
 * The real night sky over Boston: 8,920 catalogued stars to magnitude 6.5,
 * drawn as additive points at their true J2000 positions, rotated into the
 * local horizon frame by the observer's latitude and local sidereal time.
 * Orion rises in the east in winter; the Big Dipper wheels round Polaris at
 * 42 degrees above the northern horizon. It is not decoration, it is the sky.
 *
 * Each star carries its catalogue magnitude and its B-V colour index, so Rigel
 * is blue-white, Betelgeuse and Antares are orange, and the field has the
 * colour variety a long exposure shows.
 *
 * Visibility is driven physically rather than with a switch:
 *   - a limiting magnitude that walks from about 1.2 at civil twilight down to
 *     6.5 once the sun is 17 degrees under, which is what makes stars *emerge*
 *     rather than pop;
 *   - Kasten-Young airmass extinction, so the horizon eats the faint ones;
 *   - the urban skyglow raises the limiting magnitude again, because from the
 *     Common you see maybe forty stars, not nine thousand;
 *   - the volumetric cloud buffer occludes them.
 */

const STAR_VERT = /* glsl */ `
attribute vec3 aDir;      // J2000 equatorial unit vector
attribute float aMag;     // visual magnitude
attribute vec3 aColor;    // linear sRGB, luminance-normalised

uniform mat3 uSkyRotation;
uniform float uPixelScale;
uniform float uLimitMag;
uniform float uSizeScale;

varying vec3 vColor;
varying float vBright;
varying float vAltitude;
varying float vSeed;

void main() {
  vec3 dir = uSkyRotation * aDir;
  vAltitude = dir.y;
  vSeed = aMag * 37.13 + aDir.x * 91.7 + aDir.z * 13.7;

  // Project a point at infinity: transform the direction with w = 0, then
  // force z just inside the far plane so nothing clips it.
  vec4 clip = projectionMatrix * vec4( mat3( viewMatrix ) * dir, 0.0 );
  gl_Position = vec4( clip.xy, clip.w * 0.99999, clip.w );

  // Flux relative to a magnitude-0 star.
  float flux = pow( 10.0, -0.4 * aMag );
  float vis = smoothstep( uLimitMag + 0.9, uLimitMag - 0.6, aMag );

  // Bright stars get a visibly larger disc; faint ones stay sub-pixel-ish.
  float size = ( 1.35 + 2.6 * pow( clamp( flux, 0.0, 1.0 ), 0.20 ) ) * uPixelScale * uSizeScale;
  gl_PointSize = size;

  // Spread the flux over the disc so the total energy stays right.
  vBright = flux * vis * 9.0 / ( size * size );
  vColor = aColor;
}
`;

const STAR_FRAG = /* glsl */ `
precision highp float;

${NOISE_GLSL}

varying vec3 vColor;
varying float vBright;
varying float vAltitude;
varying float vSeed;

uniform sampler2D uCloudBuffer;
uniform vec2 uResolution;
uniform float uTime;
uniform float uCloudsEnabled;
uniform float uExtinction;
uniform float uTwinkle;
uniform float uIntensity;

void main() {
  if ( vBright <= 0.0 || vAltitude < -0.02 ) discard;

  // Gaussian point spread, so stars are soft dots rather than squares.
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot( d, d ) * 4.0;
  float psf = exp( -r2 * 3.4 );
  if ( psf < 0.002 ) discard;

  // Kasten-Young airmass, then roughly 0.21 mag of extinction per airmass.
  float altDeg = degrees( asin( clamp( vAltitude, -1.0, 1.0 ) ) );
  float airmass = 1.0 / ( max( vAltitude, 0.0 ) + 0.50572 * pow( max( altDeg + 6.07995, 0.3 ), -1.6364 ) );
  airmass = min( airmass, 12.0 );
  float extinction = exp( -uExtinction * airmass );
  float horizonFade = smoothstep( -0.02, 0.035, vAltitude );

  // Scintillation: fast, and much stronger near the horizon where the air is
  // thick — the reason Sirius flashes colours low in the winter sky.
  float tw = 1.0 + uTwinkle * min( airmass, 6.0 ) * 0.1 *
    ( sin( uTime * 6.1 + vSeed ) * 0.6 + sin( uTime * 11.3 + vSeed * 2.7 ) * 0.4 );

  vec3 col = vColor * vBright * psf * extinction * horizonFade * max( tw, 0.0 ) * uIntensity;

  if ( uCloudsEnabled > 0.5 ) {
    col *= texture2D( uCloudBuffer, gl_FragCoord.xy / uResolution ).a;
  }

  gl_FragColor = vec4( col, 1.0 );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Starfield {
  readonly points: THREE.Points;
  private material: THREE.ShaderMaterial;
  private geometry: THREE.BufferGeometry;
  private rotation = new THREE.Matrix3();

  constructor(maxStars: number) {
    const cat = starCatalogue();
    const n = Math.min(maxStars, cat.ra.length);

    const dir = new Float32Array(n * 3);
    const mag = new Float32Array(n);
    const col = new Float32Array(n * 3);
    const tmp = new THREE.Color();

    for (let i = 0; i < n; i++) {
      const ra = cat.ra[i];
      const dec = cat.dec[i];
      const cd = Math.cos(dec);
      dir[i * 3] = cd * Math.cos(ra);
      dir[i * 3 + 1] = cd * Math.sin(ra);
      dir[i * 3 + 2] = Math.sin(dec);
      mag[i] = cat.mag[i];
      blackbodyToLinearRGB(bvToKelvin(cat.bv[i]), tmp);
      // Pull the saturation back a touch: the eye sees stars near the edge of
      // photopic vision, where colour response is weak.
      col[i * 3] = tmp.r * 0.78 + 0.22;
      col[i * 3 + 1] = tmp.g * 0.78 + 0.22;
      col[i * 3 + 2] = tmp.b * 0.78 + 0.22;
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.geometry.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
    this.geometry.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

    this.material = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: {
        uSkyRotation: { value: this.rotation },
        uPixelScale: { value: 1 },
        uLimitMag: { value: -2 },
        uSizeScale: { value: 1 },
        uCloudBuffer: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 },
        uCloudsEnabled: { value: 0 },
        uExtinction: { value: 0.21 },
        uTwinkle: { value: 1 },
        uIntensity: { value: 1 },
      },
      // Not flagged `transparent`, deliberately: that would push the stars
      // into the transparent pass, which is drawn after the city and would
      // paint them over every rooftop. As an opaque-list object with a very
      // negative render order they land straight after the sky dome, against
      // a still-empty depth buffer, and the city then covers them normally.
      transparent: false,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = -9990;
    this.points.name = 'sky-starfield';
    this.points.matrixAutoUpdate = false;
  }

  get uniforms(): Record<string, THREE.IUniform> {
    return this.material.uniforms;
  }

  /**
   * Orients the celestial sphere for the observer.
   *
   * Composition, right to left: a reflection that turns right ascension into
   * hour angle about the polar axis, a rotation that tilts the pole down to
   * the observer's latitude, and a relabelling of east-north-up into the
   * world's +X east / +Y up / +Z south.
   *
   * @param lst local *apparent* sidereal time, radians.
   * @param latitude radians.
   */
  setOrientation(lst: number, latitude: number): void {
    const c = Math.cos(lst);
    const s = Math.sin(lst);
    const sp = Math.sin(latitude);
    const cp = Math.cos(latitude);

    // ENU = M * (R * equatorial)
    //   R = [[c, s, 0], [s, -c, 0], [0, 0, 1]]
    //   M = [[0, -1, 0], [-sp, 0, cp], [cp, 0, sp]]
    // world = (e, u, -n)
    const m = [
      [0, -1, 0],
      [-sp, 0, cp],
      [cp, 0, sp],
    ];
    const r = [
      [c, s, 0],
      [s, -c, 0],
      [0, 0, 1],
    ];
    // enu[i][j] = sum_k m[i][k] * r[k][j]
    const enu: number[][] = [];
    for (let i = 0; i < 3; i++) {
      enu.push([0, 0, 0]);
      for (let j = 0; j < 3; j++) {
        let acc = 0;
        for (let k = 0; k < 3; k++) acc += m[i][k] * r[k][j];
        enu[i][j] = acc;
      }
    }
    // Reorder rows to world axes: X = east, Y = up, Z = -north.
    this.rotation.set(
      enu[0][0], enu[0][1], enu[0][2],
      enu[2][0], enu[2][1], enu[2][2],
      -enu[1][0], -enu[1][1], -enu[1][2],
    );
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
