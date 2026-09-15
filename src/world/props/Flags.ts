/**
 * The flags on Boston's buildings.
 *
 * Three families, built from the same cloth shader and the same procedural
 * texture (`flagCloth.ts`, `flagTexture.ts`), placed by `flagSites.ts`:
 *
 *  1. **Facade staffs.** A socket bracket above the storefront cornice and a
 *     staff raked 36-46 degrees out of the wall, union at the peak as the flag
 *     code asks. The commonest by a wide margin.
 *  2. **Parapet flagpoles.** Vertical, standing on a flat roof deck behind the
 *     coping. Free to rotate, so they stream downwind.
 *  3. **Hanging banners.** No staff: hoist along a bar at the top, several
 *     storeys of drop, union uppermost and to the observer's left.
 *
 * Geometry for every family is authored in the cloth's local frame — +X along
 * the fly, +Y along the hoist, +Z the sheet's normal — so a single instance
 * matrix carries the staff, its flag and its finial together, and the fly
 * dimension is whatever the shader's `uSize` says it is.
 *
 * **Wall clearance** is the one thing that has to be right by construction
 * rather than by eye. Each facade flag's fly direction is
 * `0.80 * alongWall + 0.60 * droop`, where `droop` is gravity projected
 * perpendicular to the staff and therefore points *out* of the wall, not into
 * it. Every term in the cloth — the staff offset, the fly, the hoist — then
 * has a positive outward component, so the sheet can only ever move away from
 * the masonry; the wave and the swing together cannot close the remaining
 * metre. Banners get the same treatment with an outward bias on the swing.
 *
 * Six instanced meshes — cloth and hardware for each family — which measure at
 * 18 draw calls and 11k to 35k triangles with everything in range (the
 * hardware also draws into the three shadow cascades), and nothing at all from
 * two kilometres up, where the distance cull has taken the lot. The cloth
 * carries `noShadow`: a double-sided sheet writes its own front faces into the
 * shadow map and then fails the comparison against itself, which on a flag is
 * a black flickering rag.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Ctx } from '../../core/Context';
import { FLAG_RATIO, usFlagTexture } from './flagTexture';
import {
  advanceFlagWind, clothGeometry, createFlagMaterial, createFlagWind, type FlagWind,
} from './flagCloth';
import { planFlags, type BannerSite, type PoleSite, type StaffSite } from './flagSites';

// ---------------------------------------------------------------------------
// dimensions, metres
// ---------------------------------------------------------------------------

/** 3 x 5 ft-ish facade flag, at the regulation 10:19. */
const STAFF_HOIST = 0.80;
const STAFF_FLY = STAFF_HOIST * FLAG_RATIO;     // 1.52
/** Bracket to the foot of the hoist, along the staff. */
const STAFF_ATTACH = 1.00;
const STAFF_TIP = 0.34;
const STAFF_BACK = 0.36;

/** Roof and ground poles fly a bigger flag: 4.5 x 8.5 ft. */
const POLE_HOIST = 1.40;
const POLE_FLY = POLE_HOIST * FLAG_RATIO;       // 2.66
/** Truck height above the top of the wall. */
const POLE_ABOVE = 8.0;
/**
 * How far the pole runs below that. The roof deck sits somewhere between 0.2
 * and 1.2 m under the coping depending on the parapet the Buildings module
 * drew, and there is no way to know which from here — so the pole simply
 * continues past every possibility and the shoe is left off. A base plate
 * guessed 40 cm wrong reads as a flagpole floating over its own roof.
 */
const POLE_BURY = 3.2;
const POLE_HEAD = 0.30;                          // truck to the union

const BANNER_DROP = 16.0;
const BANNER_HOIST = BANNER_DROP / FLAG_RATIO;  // 8.42
const BANNER_STANDOFF = 0.62;

/** Beyond these, in three dimensions, the flag is under a couple of pixels. */
const CULL_STAFF = 430;
const CULL_POLE = 1150;
const CULL_BANNER = 2200;

const UP = new THREE.Vector3(0, 1, 0);

function flat(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  if (out !== g) g.dispose();
  return out;
}

function merge(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return mergeGeometries(gs.map(flat), false)!;
}

/** A cylinder along local +Y spanning [y0, y1]. */
function rod(r0: number, r1: number, y0: number, y1: number, seg = 7, x = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, y1 - y0, seg, 1);
  g.translate(x, (y0 + y1) * 0.5, z);
  return g;
}

// ---------------------------------------------------------------------------
// hardware
// ---------------------------------------------------------------------------

/** Socket bracket, staff and finial, in the cloth's frame. */
function staffHardware(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    // The staff runs past the bracket into the masonry, which is what hides
    // the joint on a facade whose reveals live in a texture, not in geometry.
    rod(0.026, 0.017, -STAFF_ATTACH - STAFF_BACK, STAFF_HOIST + STAFF_TIP, 7),
    // Cast socket at the bracket.
    rod(0.055, 0.048, -STAFF_ATTACH - 0.02, -STAFF_ATTACH + 0.2, 8),
    rod(0.042, 0.042, -STAFF_ATTACH + 0.2, -STAFF_ATTACH + 0.26, 8),
  ];
  const ball = new THREE.SphereGeometry(0.043, 8, 6);
  ball.translate(0, STAFF_HOIST + STAFF_TIP, 0);
  parts.push(ball);
  return merge(parts);
}

/** Parapet flagpole: tapered pole through the deck, truck at the top. */
function poleHardware(): THREE.BufferGeometry {
  const top = POLE_HOIST + POLE_HEAD;
  const parts: THREE.BufferGeometry[] = [
    rod(0.09, 0.042, top - POLE_ABOVE - POLE_BURY, top, 9),
  ];
  const truck = new THREE.SphereGeometry(0.072, 8, 6);
  truck.translate(0, top, 0);
  parts.push(truck);
  return merge(parts);
}

/** Banner bar and the two stubs that hold it off the wall. */
function bannerHardware(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    rod(0.075, 0.075, -0.42, BANNER_HOIST + 0.42, 8, 0.08, BANNER_STANDOFF),
  ];
  for (const y of [0.8, BANNER_HOIST - 0.8]) {
    const arm = new THREE.BoxGeometry(0.1, 0.12, BANNER_STANDOFF + 0.1);
    arm.translate(0.08, y, BANNER_STANDOFF * 0.5);
    parts.push(arm);
    const pad = new THREE.BoxGeometry(0.18, 0.3, 0.06);
    pad.translate(0.08, y, 0.02);
    parts.push(pad);
  }
  const cap = new THREE.SphereGeometry(0.09, 8, 6);
  cap.translate(0.08, BANNER_HOIST + 0.42, BANNER_STANDOFF);
  parts.push(cap);
  return merge(parts);
}

// ---------------------------------------------------------------------------
// the field
// ---------------------------------------------------------------------------

interface Group {
  meshes: THREE.InstancedMesh[];
  matrices: Float32Array;
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  cull: number;
}

export class FlagField {
  private root = new THREE.Group();
  private groups: Group[] = [];
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private tex: THREE.Texture | null = null;
  private poleMat: THREE.MeshStandardMaterial | null = null;
  private wind: FlagWind;
  private lastCull = new THREE.Vector3(1e9, 1e9, 1e9);

  counts = { staff: 0, pole: 0, banner: 0 };

  constructor(wind?: FlagWind) {
    this.wind = wind ?? createFlagWind();
    this.root.name = 'props:flags';
  }

  /** Cloth for anything on a vertical pole: the parapet flagpoles. */
  private poleCloth(ctx: Ctx): THREE.MeshStandardMaterial {
    if (!this.poleMat) {
      this.poleMat = createFlagMaterial({
        name: 'pole',
        map: this.texture(ctx),
        wind: this.wind,
        mount: 'pole',
        size: new THREE.Vector2(POLE_FLY, POLE_HOIST),
        amplitude: 0.205,
        wavelength: 0.98,
        speed: 4.2,
        twist: 0.5,
        sag: new THREE.Vector3(0, -0.22, 0.07),
        swing: new THREE.Vector2(0.1, 0),
      });
      this.mats.push(this.poleMat);
    }
    return this.poleMat;
  }

  private texture(ctx: Ctx): THREE.Texture {
    this.tex ??= usFlagTexture(
      ctx.quality.detailDistance > 700 ? 640 : 448,
      ctx.quality.anisotropy,
    );
    return this.tex;
  }

  async build(ctx: Ctx, metal: THREE.Material): Promise<void> {
    const plan = await planFlags();
    if (!plan.staff.length && !plan.pole.length && !plan.banner.length) return;

    ctx.scene.add(this.root);
    const map = this.texture(ctx);

    this.addStaffs(plan.staff, map, metal);
    this.addPoles(ctx, plan.pole, metal);
    this.addBanners(plan.banner, map, metal);

    this.counts = {
      staff: plan.staff.length,
      pole: plan.pole.length,
      banner: plan.banner.length,
    };
    console.info(
      `[Props] flags: ${this.counts.staff} facade staffs, ${this.counts.pole} roof poles, ` +
      `${this.counts.banner} hanging banners across ${plan.examined} buildings`,
    );
  }

  // -- construction --------------------------------------------------------

  private group(
    cull: number,
    n: number,
    compose: (i: number, m: THREE.Matrix4, origin: THREE.Vector3) => void,
    parts: Array<{
      geo: THREE.BufferGeometry; mat: THREE.Material; cloth: boolean; noShadow?: boolean;
    }>,
  ): void {
    const matrices = new Float32Array(n * 16);
    const px = new Float32Array(n);
    const py = new Float32Array(n);
    const pz = new Float32Array(n);
    const m = new THREE.Matrix4();
    const o = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      compose(i, m, o);
      m.toArray(matrices, i * 16);
      px[i] = o.x;
      py[i] = o.y;
      pz[i] = o.z;
    }

    const meshes: THREE.InstancedMesh[] = [];
    for (const part of parts) {
      const mesh = new THREE.InstancedMesh(part.geo, part.mat, n);
      mesh.name = `prop:flag:${part.cloth ? 'cloth' : 'metal'}`;
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      // Cloth never casts: a DoubleSide sheet shadows itself. The sweep in
      // SceneShading forces castShadow on unless this flag is set.
      if (part.cloth || part.noShadow) {
        mesh.userData.noShadow = true;
        mesh.castShadow = false;
      }
      (mesh.instanceMatrix.array as Float32Array).set(matrices);
      mesh.instanceMatrix.needsUpdate = true;
      this.root.add(mesh);
      meshes.push(mesh);
      this.geos.push(part.geo);
    }
    this.groups.push({ meshes, matrices, px, py, pz, cull });
  }

  private addStaffs(sites: StaffSite[], map: THREE.Texture, metal: THREE.Material): void {
    if (!sites.length) return;
    const cloth = createFlagMaterial({
      name: 'staff',
      map,
      wind: this.wind,
      mount: 'staff',
      size: new THREE.Vector2(STAFF_FLY, STAFF_HOIST),
      // A metre and a half of fly carries under two wavelengths. Any shorter
      // and the analytic normals swing past 45 degrees, at which point half
      // the sheet faces away from the sun and a small flag reads as crumpled
      // foil rather than cloth.
      amplitude: 0.095,
      wavelength: 0.82,
      speed: 5.3,
      twist: 0.38,
      // Gravity, projected off the staff: down the hoist and a little forward,
      // which is the bag a short flag on a raked staff actually takes.
      sag: new THREE.Vector3(0, -0.116, 0.104),
      swing: new THREE.Vector2(0.16, 0),
    });
    this.mats.push(cloth);

    const n3 = new THREE.Vector3();
    const t = new THREE.Vector3();
    const fg = new THREE.Vector3();
    const ax = new THREE.Vector3();
    const ay = new THREE.Vector3();
    const az = new THREE.Vector3();

    this.group(
      CULL_STAFF,
      sites.length,
      (i, m, origin) => {
        const s = sites[i];
        n3.set(s.n.x, 0, s.n.y);
        // Along the wall, on the side the prevailing wind favours.
        t.set(s.n.y * s.side, 0, -s.n.x * s.side);
        const c = Math.cos(s.tilt);
        const sn = Math.sin(s.tilt);
        ay.copy(n3).multiplyScalar(c).addScaledVector(UP, sn);      // the staff
        fg.copy(n3).multiplyScalar(sn).addScaledVector(UP, -c);     // droop, outward
        ax.copy(t).multiplyScalar(0.8).addScaledVector(fg, 0.6).normalize();
        az.crossVectors(ax, ay).normalize();
        origin
          .copy(s.p)
          .addScaledVector(n3, 0.12)
          .addScaledVector(ay, STAFF_ATTACH * s.scale);
        m.makeBasis(
          ax.multiplyScalar(s.scale),
          ay.clone().multiplyScalar(s.scale),
          az.multiplyScalar(s.scale),
        ).setPosition(origin);
      },
      [
        // A two-metre staff's shadow is not worth a shadow-pass draw call.
        { geo: staffHardware(), mat: metal, cloth: false, noShadow: true },
        {
          geo: clothGeometry({ fly: STAFF_FLY, hoist: STAFF_HOIST, segU: 12, segV: 5 }),
          mat: cloth,
          cloth: true,
        },
      ],
    );
  }

  private addPoles(ctx: Ctx, sites: PoleSite[], metal: THREE.Material): void {
    if (!sites.length) return;
    const cloth = this.poleCloth(ctx);

    const ax = new THREE.Vector3(0.9394, 0, 0.3429);
    const az = new THREE.Vector3().crossVectors(ax, UP);
    const deckToOrigin = POLE_ABOVE - POLE_HOIST - POLE_HEAD;

    this.group(
      CULL_POLE,
      sites.length,
      (i, m, origin) => {
        const s = sites[i];
        origin.set(s.p.x, s.p.y + deckToOrigin * s.scale, s.p.z);
        m.makeBasis(
          ax.clone().multiplyScalar(s.scale),
          new THREE.Vector3(0, s.scale, 0),
          az.clone().multiplyScalar(s.scale),
        ).setPosition(origin);
      },
      [
        { geo: poleHardware(), mat: metal, cloth: false },
        {
          geo: clothGeometry({ fly: POLE_FLY, hoist: POLE_HOIST, segU: 14, segV: 6 }),
          mat: cloth,
          cloth: true,
        },
      ],
    );
  }

  private addBanners(sites: BannerSite[], map: THREE.Texture, metal: THREE.Material): void {
    if (!sites.length) return;
    const cloth = createFlagMaterial({
      name: 'banner',
      map,
      wind: this.wind,
      mount: 'banner',
      size: new THREE.Vector2(BANNER_DROP, BANNER_HOIST),
      amplitude: 0.52,
      wavelength: 3.4,
      speed: 1.45,
      twist: 0.3,
      // The fly already points straight down, so there is nothing to sag; the
      // positive Z is the bottom of the sheet bellying away from the wall.
      sag: new THREE.Vector3(0, 0, 0.5),
      // Biased outward, never inward: 16 m of drop at 0.06 rad is a metre of
      // clearance, which the wave and the oscillation together cannot spend.
      swing: new THREE.Vector2(0.03, -0.062),
    });
    this.mats.push(cloth);

    const ax = new THREE.Vector3(0, -1, 0);
    const ay = new THREE.Vector3();
    const az = new THREE.Vector3();

    this.group(
      CULL_BANNER,
      sites.length,
      (i, m, origin) => {
        const s = sites[i];
        ay.set(s.n.y, 0, -s.n.x);
        az.crossVectors(ax, ay);
        origin.copy(s.p).addScaledVector(ay, -BANNER_HOIST * 0.5 * s.scale);
        m.makeBasis(
          ax.clone().multiplyScalar(s.scale),
          ay.clone().multiplyScalar(s.scale),
          az.clone().multiplyScalar(s.scale),
        ).setPosition(origin);
      },
      [
        { geo: bannerHardware(), mat: metal, cloth: false },
        {
          geo: clothGeometry({
            fly: BANNER_DROP,
            hoist: BANNER_HOIST,
            segU: 16,
            segV: 10,
            mirrorHoist: true,
            offset: new THREE.Vector3(0, 0, BANNER_STANDOFF),
          }),
          mat: cloth,
          cloth: true,
        },
      ],
    );
  }

  // -- runtime -------------------------------------------------------------

  update(dt: number, ctx: Ctx): void {
    advanceFlagWind(this.wind, dt);
    if (!this.groups.length) return;
    // Three dimensions, not two: from two kilometres up, every flag in the
    // city is within a couple of hundred metres horizontally.
    if (ctx.camera.position.distanceTo(this.lastCull) < 25) return;
    this.lastCull.copy(ctx.camera.position);
    const { x: cx, y: cy, z: cz } = ctx.camera.position;

    for (const g of this.groups) {
      const cull = g.cull * g.cull;
      let n = 0;
      for (let i = 0; i < g.px.length; i++) {
        const dx = g.px[i] - cx;
        const dy = g.py[i] - cy;
        const dz = g.pz[i] - cz;
        if (dx * dx + dy * dy + dz * dz > cull) continue;
        // Write every kept instance, including the ones whose slot index has
        // not changed: the previous pass compacted this buffer, so slot `n`
        // holds whichever flag happened to land there last time, not flag `n`.
        // Skipping the copy when `n === i` left flags bolted to the wrong
        // buildings the moment the camera moved twice.
        for (const mesh of g.meshes) {
          (mesh.instanceMatrix.array as Float32Array).set(
            g.matrices.subarray(i * 16, i * 16 + 16),
            n * 16,
          );
        }
        n++;
      }
      for (const mesh of g.meshes) {
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  dispose(ctx: Ctx): void {
    ctx.scene.remove(this.root);
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.tex?.dispose();
    this.groups.length = 0;
    this.geos.length = 0;
    this.mats.length = 0;
    this.tex = null;
    this.poleMat = null;
  }
}
