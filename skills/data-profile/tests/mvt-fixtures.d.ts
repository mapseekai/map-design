declare module '@mapbox/mvt-fixtures' {
  export function create(input: unknown): {buffer: Uint8Array};
  export function get(id: string | number): {buffer: Uint8Array};
}
