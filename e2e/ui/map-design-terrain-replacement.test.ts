import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

test('[P1] replacing a terrain style while moving keeps its projection ready for rendering', async ({ page }, testInfo) => {
  const requireWeb = createRequire(new URL('../../apps/web/package.json', import.meta.url));
  const distribution = join(dirname(requireWeb.resolve('maplibre-gl/package.json')), 'dist');
  const source = await readFile(new URL('../../apps/web/src/map-design/map/map-design-map.ts', import.meta.url), 'utf8');
  const module = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText;
  const tile = new PNG({ width: 256, height: 256 });
  for (let index = 0; index < tile.data.length; index += 4) {
    tile.data.set([1, 134, 160, 255], index);
  }
  const image = PNG.sync.write(tile);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  await page.route('http://terrain.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') {
      await route.fulfill({ contentType: 'text/html', body: `
        <div id="map" style="width:800px;height:500px"></div><output id="result"></output>
        <script type="importmap">{"imports":{"maplibre-gl":"/maplibre/maplibre-gl.mjs"}}</script>
        <script type="module">
          import { MapDesignMap } from '/map-design-map.js';
          const style = {version:8,projection:{type:'mercator'},sources:{dem:{type:'raster-dem',tiles:['http://terrain.test/{z}/{x}/{y}.png'],tileSize:256,maxzoom:1}},terrain:{source:'dem'},layers:[{id:'background',type:'background',paint:{'background-color':'#f2e9da'}}]};
          const map = new MapDesignMap({container:'map',style,zoom:1,pitch:45});
          const results = [];
          try {
            await map.once('idle');
            for (let index = 0; index < 20; index++) {
              map.triggerRepaint();
              map.setStyle(structuredClone(style), {diff:false});
              map.resize();
              map.jumpTo({center:[index,0],zoom:2,pitch:60});
              await map.once('idle');
              results.push({terrain:map.getTerrain()?.source,projection:map.getProjection().type,loaded:map.isStyleLoaded()});
            }
            document.querySelector('#result').textContent = JSON.stringify(results);
          } catch (error) {
            document.querySelector('#result').textContent = String(error);
            throw error;
          }
        </script>` });
    } else if (path === '/map-design-map.js') {
      await route.fulfill({ contentType: 'text/javascript', body: module });
    } else if (path.endsWith('.png')) {
      await route.fulfill({ contentType: 'image/png', body: image });
    } else if (/^\/maplibre\/maplibre-gl(?:-shared|-worker)?\.mjs$/.test(path)) {
      await route.fulfill({ contentType: 'text/javascript', body: await readFile(join(distribution, path.split('/').at(-1) ?? '')) });
    } else {
      await route.abort();
    }
  });
  await page.goto('http://terrain.test/');
  await expect(page.locator('#result')).not.toBeEmpty({ timeout: 30_000 });
  expect(JSON.parse(await page.locator('#result').innerText())).toEqual(
    Array.from({ length: 20 }, () => ({ terrain: 'dem', projection: 'mercator', loaded: true })),
  );
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('terrain-replacements.png') });
});
