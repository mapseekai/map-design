import type { AddProtocolAction, RequestParameters } from 'maplibre-gl';
import { PMTiles, Protocol } from 'pmtiles';

import { GatewayPmtilesSource, type GatewayPmtilesSourceOptions } from './gateway-pmtiles-source';
import { assertMapDesignGatewayUrl, stripProtocol } from './resource-protocol';

export const PMTILES_PROTOCOL = 'pmtiles';

export function createMapDesignPmtilesProtocol(options: GatewayPmtilesSourceOptions = {}): AddProtocolAction {
  const protocol = new Protocol();
  return (request: RequestParameters, abortController: AbortController) => {
    const raw = stripProtocol(request.url, PMTILES_PROTOCOL);
    const parsed = parseArchiveRequest(raw);
    const archiveUrl = assertMapDesignGatewayUrl(parsed.archive, options.origin);
    if (!protocol.get(archiveUrl.href)) {
      const archive = new PMTiles(new GatewayPmtilesSource(archiveUrl.href, options));
      protocol.add(archive);
    }
    return protocol.tile({
      ...request,
      url: `${PMTILES_PROTOCOL}://${archiveUrl.href}${parsed.tilePath}`,
    }, abortController);
  };
}

function parseArchiveRequest(value: string): { archive: string; tilePath: string } {
  const match = value.match(/^(.*\/archive\.pmtiles)(\/\d+\/\d+\/\d+)?$/u);
  if (!match?.[1]) throw new TypeError('Invalid MapDesign PMTiles protocol URL.');
  return { archive: match[1], tilePath: match[2] ?? '' };
}
