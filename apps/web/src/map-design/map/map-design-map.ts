import { Map } from 'maplibre-gl';

export class MapDesignMap extends Map {
  override setStyle(style: Parameters<Map['setStyle']>[0], options?: Parameters<Map['setStyle']>[1]): this {
    // MapLibre 6.3 can render old terrain before the replacement style initializes its projection.
    if (options?.diff === false && this.getTerrain()) this.setTerrain(null);
    return super.setStyle(style, options);
  }
}
