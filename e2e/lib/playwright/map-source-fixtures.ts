import type { Page } from '@playwright/test';

/** Deterministic browser resources for UI tests; external acceptance stays explicitly opt-in. */
export async function routeMapSourceFixtures(page: Page): Promise<void> {
  await page.route('https://demotiles.maplibre.org/**', async (route) => {
    await route.fulfill({ contentType: 'application/json', json: {
      version: 8, center: [0, 0], zoom: 1,
      sources: { fixture: { type: 'geojson', data: { type: 'FeatureCollection', features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-30,-25],[45,-25],[45,40],[-30,40],[-30,-25]]] } },
      ] } } },
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#d9e8f0' } },
        { id: 'land', type: 'fill', source: 'fixture', paint: { 'fill-color': '#b4cfac' } },
        { id: 'boundary', type: 'line', source: 'fixture', paint: { 'line-color': '#536b48', 'line-width': 3 } },
      ],
    } });
  });
}
