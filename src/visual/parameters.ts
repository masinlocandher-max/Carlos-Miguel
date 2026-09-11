import type { JewelState } from '../lib/model';
export type Parameters = {
  eyes: number;
  density: number;
  brightness: number;
  speed: number;
  rings: number;
  scan: number;
  depth: number;
};
export const parameters: Record<JewelState, Parameters> = {
  idle: {
    eyes: 0,
    density: 0.64,
    brightness: 0.75,
    speed: 0.1,
    rings: 3,
    scan: 0.02,
    depth: 0.003,
  },
  listening: {
    eyes: 1,
    density: 0.8,
    brightness: 0.92,
    speed: 0.23,
    rings: 4,
    scan: 0.14,
    depth: 0.008,
  },
  thinking: {
    eyes: 1,
    density: 0.94,
    brightness: 1.15,
    speed: 0.55,
    rings: 7,
    scan: 0.5,
    depth: 0.012,
  },
  executing: {
    eyes: 1,
    density: 1,
    brightness: 1.3,
    speed: 0.85,
    rings: 9,
    scan: 0.85,
    depth: 0.016,
  },
  complete: {
    eyes: 1,
    density: 0.85,
    brightness: 1,
    speed: 0.27,
    rings: 5,
    scan: 0.12,
    depth: 0.007,
  },
};
export function blendParameters(current: Parameters, target: Parameters, dt: number): void {
  const ease = 1 - Math.exp(-Math.min(dt, 0.1) * 2.3);
  for (const key of Object.keys(current) as (keyof Parameters)[])
    current[key] += (target[key] - current[key]) * ease;
}
