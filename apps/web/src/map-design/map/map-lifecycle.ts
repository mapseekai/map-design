import type { AddProtocolAction } from 'maplibre-gl';

import { createMapDesignPmtilesProtocol, PMTILES_PROTOCOL } from './pmtiles-protocol';
import { createMapDesignResourceProtocol, MAP_DESIGN_RESOURCE_PROTOCOL } from './resource-protocol';

export interface MapLibreProtocolApi {
  setWorkerUrl?(url: string): void;
  addProtocol(scheme: string, handler: AddProtocolAction): void;
  removeProtocol(scheme: string): void;
}

export interface MapDesignProtocolOptions {
  origin?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit;
}

interface ProtocolState { owners: number }
let states = new WeakMap<object, ProtocolState>();

export function acquireMapDesignProtocols(api: MapLibreProtocolApi, options: MapDesignProtocolOptions = {}): () => void {
  const key = api as object;
  let state = states.get(key);
  if (!state) {
    api.addProtocol(MAP_DESIGN_RESOURCE_PROTOCOL, createMapDesignResourceProtocol(options));
    api.addProtocol(PMTILES_PROTOCOL, createMapDesignPmtilesProtocol(options));
    state = { owners: 0 };
    states.set(key, state);
  }
  state.owners += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = states.get(key);
    if (!current) return;
    current.owners -= 1;
    if (current.owners > 0) return;
    api.removeProtocol(MAP_DESIGN_RESOURCE_PROTOCOL);
    api.removeProtocol(PMTILES_PROTOCOL);
    states.delete(key);
  };
}

export function resetMapDesignProtocolsForTests(): void {
  states = new WeakMap<object, ProtocolState>();
}
