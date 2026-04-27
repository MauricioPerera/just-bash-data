/** Seeded LCG so vector tests are deterministic across runs. */
export class SeededPrng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }
  next(): number {
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state / 0xffffffff;
  }
  vector(dim: number, scale = 1): number[] {
    return Array.from({ length: dim }, () => (this.next() - 0.5) * scale);
  }
}

export const sampleDocs = (n: number): Array<Record<string, unknown>> => {
  const tags = ["alpha", "beta", "gamma"];
  return Array.from({ length: n }, (_, i) => ({
    name: `doc-${i}`,
    age: 18 + (i % 60),
    tag: tags[i % tags.length] as string,
  }));
};

export const sampleVectors = (
  n: number,
  dim: number,
  seed = 42,
): Array<{ id: string; vector: number[]; metadata?: Record<string, unknown> }> => {
  const prng = new SeededPrng(seed);
  return Array.from({ length: n }, (_, i) => ({
    id: `vec-${i}`,
    vector: prng.vector(dim),
    metadata: { idx: i },
  }));
};
