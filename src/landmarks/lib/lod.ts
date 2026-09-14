/**
 * LOD plumbing shared by every landmark.
 *
 * A landmark is a `THREE.LOD` whose levels are complete, independently merged
 * models. Distances are tuned so the swap happens where the detail it drops is
 * already sub-pixel: ~1 px of screen error at a 52 degree FOV on a 1080p frame
 * is roughly `feature_size * 1900 / distance`, so a 1.4 m window pane stops
 * mattering past ~2.5 km and a 0.3 m mullion past ~550 m.
 */
import * as THREE from 'three';
import { countTriangles } from './geom';

export interface LodLevel {
  object: THREE.Object3D;
  /** Camera distance in metres at which this level takes over. */
  distance: number;
}

export function makeLOD(name: string, levels: LodLevel[]): THREE.LOD {
  const lod = new THREE.LOD();
  lod.name = name;
  let tris = 0;
  for (const l of levels) {
    l.object.name = `${name}:lod${l.distance}`;
    lod.addLevel(l.object, l.distance);
    tris += countTriangles(l.object);
  }
  lod.userData.triangles = countTriangles(levels[0]?.object ?? lod);
  lod.userData.trianglesAllLevels = tris;
  lod.userData.lodCount = levels.length;
  lod.userData.lodDistances = levels.map((l) => l.distance);
  return lod;
}

/** Shadow flags applied uniformly; landmarks always cast and receive. */
export function shadowed(o: THREE.Object3D): THREE.Object3D {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
  return o;
}
