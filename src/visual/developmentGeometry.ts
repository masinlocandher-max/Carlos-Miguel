/** Neutral mathematical development core. No image input, face landmarks or likeness data. */
export function createDevelopmentGeometry() {
  const count = 12000;
  const values = new Float32Array(count * 6);
  const filaments: number[] = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const radius = Math.sqrt(1 - y * y);
    const angle = i * goldenAngle;
    const x = Math.cos(angle) * radius * 0.78;
    const vertical = y * 0.78;
    const z = Math.sin(angle) * radius * 0.38;
    const light = 0.16 + 0.2 * Math.pow(Math.cos(y * Math.PI * 3), 2);
    values.set([x, vertical, z, light, light * 1.2, ((i * 1597) % count) / count], i * 6);
  }
  for (let ring = 0; ring < 7; ring++) {
    const y = (ring - 3) * 0.19;
    const radius = Math.sqrt(0.78 ** 2 - y ** 2);
    for (let step = 0; step < 96; step++) {
      for (const a of [step, step + 0.7]) {
        const angle = (a / 96) * Math.PI * 2;
        filaments.push(Math.cos(angle) * radius, y, Math.sin(angle) * radius * 0.48);
      }
    }
  }
  return { values, filamentValues: new Float32Array(filaments) };
}
