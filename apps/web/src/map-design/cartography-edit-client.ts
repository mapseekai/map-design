import { CartographyEditHistorySchema, CartographyActiveEditsSchema, CartographyEditSessionSchema, CartographyEditSaveOutputSchema, type CartographyEditCreate, type CartographyEditTurn } from '@mapseekai/map-design-contracts';
import { request } from '../api/request';

const base = '/api/map-design/cartography-tools/edit-sessions';
export async function listCartographyEditHistory(documentId: string, signal?: AbortSignal) {
  return CartographyEditHistorySchema.parse(await request(`${base}/history/${encodeURIComponent(documentId)}`, { signal }, (value) => CartographyEditHistorySchema.safeParse(value).success));
}
export function rememberCartographyEdit(documentId: string, sessionId: string) {
  try { localStorage.setItem(`cartography-edit:last:${documentId}`, sessionId); } catch { /* Storage is optional. */ }
}
export function lastCartographyEdit(documentId: string) {
  try { return localStorage.getItem(`cartography-edit:last:${documentId}`); } catch { return null; }
}
export async function listActiveCartographyEdits(signal?: AbortSignal) {
  return CartographyActiveEditsSchema.parse(await request(base, { signal }, (value) => CartographyActiveEditsSchema.safeParse(value).success));
}
const sessionPath = (id: string) => `${base}/${encodeURIComponent(id)}`;
const json = (value: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

export async function createCartographyEdit(input: CartographyEditCreate, signal?: AbortSignal) {
  return CartographyEditSessionSchema.parse(await request(base, { ...json(input), signal }, (value) => CartographyEditSessionSchema.safeParse(value).success));
}
export async function getCartographyEdit(id: string, signal?: AbortSignal) {
  return CartographyEditSessionSchema.parse(await request(sessionPath(id), { signal }, (value) => CartographyEditSessionSchema.safeParse(value).success));
}
export async function sendCartographyEdit(id: string, input: CartographyEditTurn) {
  return CartographyEditSessionSchema.parse(await request(`${sessionPath(id)}/turns`, json(input), (value) => CartographyEditSessionSchema.safeParse(value).success));
}
export async function cancelCartographyEdit(id: string) {
  return CartographyEditSessionSchema.parse(await request(`${sessionPath(id)}/turns`, { method: 'DELETE' }, (value) => CartographyEditSessionSchema.safeParse(value).success));
}
export async function saveCartographyEdit(id: string, expectedRevision: number) {
  return CartographyEditSaveOutputSchema.parse(await request(`${sessionPath(id)}/save`, json({ expectedRevision }), (value) => CartographyEditSaveOutputSchema.safeParse(value).success));
}
