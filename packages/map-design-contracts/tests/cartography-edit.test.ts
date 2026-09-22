import { expect, it } from 'vitest';
import { CartographyEditCreateSchema } from '../src/cartography-edit.js';

const brief = {
  name: 'Transit', requirements: 'Design a transit map',
  runtime: { agentId: 'pi', model: 'provider/custom', modelOrigin: 'custom', reasoning: 'high', serviceTier: 'fast' },
};

it('accepts a new specification brief and retains the complete runtime selection', () => {
  expect(CartographyEditCreateSchema.parse(brief)).toEqual({ ...brief, description: '' });
});

it.each([
  { ...brief, name: '' },
  { ...brief, requirements: ' ' },
  { ...brief, requirements: 'x'.repeat(8001) },
  { ...brief, source: 'ambiguous source' },
  { ...brief, runtime: 'codex' },
  { ...brief, runtime: { ...brief.runtime, modelOrigin: 'invalid' } },
])('rejects incomplete or ambiguous creation requests', (request) => {
  expect(CartographyEditCreateSchema.safeParse(request).success).toBe(false);
});

it('continues accepting existing source-based editing requests', () => {
  const request = { source: '---\nversion: "0.4.0"\nname: Transit\n---\n\n## Overview\n', initialPrompt: 'Improve labels' };
  expect(CartographyEditCreateSchema.parse(request)).toMatchObject({ ...request, runtime: 'api' });
});
