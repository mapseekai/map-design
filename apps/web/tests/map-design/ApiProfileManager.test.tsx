// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProfileManager } from '../../src/map-design/components/ApiProfileManager';
import { I18nProvider } from '../../src/i18n';
import { profilesFromConfig } from '../../src/map-design/api-profiles-client';
import type { MapApiProfilesResponse } from '@mapseekai/contracts';
const initialConfig = { byokProviders: {
  default: { name: 'Primary', protocol: 'openai' as const, apiKey: '[REDACTED]', model: 'one-model', baseUrl: 'https://one.example/v1' },
  second: { name: 'Secondary', protocol: 'openai' as const, apiKey: '[REDACTED]', model: 'two-model', baseUrl: 'https://two.example/v1' },
} };
let data: MapApiProfilesResponse;
let requests: Array<{ path: string; method: string; body: Record<string, unknown> }>;
beforeEach(() => {
  data = profilesFromConfig(initialConfig); requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const path = String(url); const method = init?.method ?? 'GET'; const body = JSON.parse(String(init?.body ?? '{}'));
    requests.push({ path, method, body }); const id = path.split('/')[4]!;
    if (method === 'PUT') {
      const profile = { ...body, id, hasApiKey: true }; delete profile.apiKey;
      data = { ...data, profiles: [...data.profiles.filter((item) => item.id !== id), profile] };
    } else if (path.endsWith('/activate')) data = { ...data, activeProfileId: id };
    else if (method === 'DELETE') data = { ...data, profiles: data.profiles.filter((item) => item.id !== id), activeProfileId: data.activeProfileId === id ? null : data.activeProfileId };
    if (path.endsWith('/test')) return new Response(JSON.stringify({ status: 'passed', testedAt: '2026-09-20T01:00:00Z', latencyMs: 12 }));
    return new Response(JSON.stringify(data));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function view() { return render(<I18nProvider initial="en"><ApiProfileManager initialConfig={initialConfig} /></I18nProvider>); }
function card(name: string) { return screen.getByText(name).closest('[data-profile-id]') as HTMLElement; }
describe('API profile settings', () => {
  it('shows saved models and key state without displaying keys or sending an automatic test', () => {
    view(); expect(screen.getByText('one-model')).toBeVisible(); expect(screen.getByText('two-model')).toBeVisible();
    expect(screen.getAllByText('Not tested')).toHaveLength(2);
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('[REDACTED]'); expect(fetch).not.toHaveBeenCalled();
  });
  it('saves a named model with immediate confirmation and shows it after reload', async () => {
    const rendered = view(); fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
    fireEvent.change(screen.getByLabelText('Configuration name'), { target: { value: 'Third' } });
    fireEvent.change(screen.getByLabelText('API model'), { target: { value: 'third-model' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://third.example/v1' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'typed-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
    expect(await screen.findByText('Third：Model saved')).toBeVisible();
    expect(screen.getByText('third-model')).toBeVisible(); expect(screen.getByLabelText('API key')).toHaveValue('');
    expect(requests[0]?.body.apiKey).toBe('typed-key'); expect(requests).toHaveLength(1);
    rendered.unmount(); render(<I18nProvider initial="en"><ApiProfileManager initialConfig={{}} initialData={data} /></I18nProvider>);
    expect(screen.getByText('Third')).toBeVisible(); expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
  });
  it('edits existing credentials by omission, tests only on click, and displays the result', async () => {
    view(); fireEvent.click(within(card('Primary')).getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('API key')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('API model'), { target: { value: 'updated-model' } });
    expect(within(card('Primary')).getByRole('button', { name: 'Test connection' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
    await screen.findByText('Primary：Model saved');
    expect(requests[0]?.body).not.toHaveProperty('apiKey');
    fireEvent.click(within(card('Primary')).getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connection verified')).toBeVisible();
    expect(requests.at(-1)).toMatchObject({ method: 'POST', path: '/api/map-design/api-profiles/default/test', body: {} });
    expect(screen.getByText(/12 ms/)).toBeInTheDocument();
  });
  it('keeps failed save drafts and shows actionable errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'API_KEY_REQUIRED_FOR_ENDPOINT' } }), { status: 400 })));
    view(); fireEvent.click(within(card('Primary')).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://different.example/v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the API key again');
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://different.example/v1');
    expect(screen.queryByText('Primary：Model saved')).not.toBeInTheDocument();
  });
  it('switches defaults, requires confirmation to delete, and updates saved entries', async () => {
    view(); fireEvent.click(within(card('Secondary')).getByRole('button', { name: 'Set as default' }));
    await screen.findByText('Secondary：Default');
    expect(within(card('Secondary')).getByRole('button', { name: 'Set as default' })).toBeDisabled();
    fireEvent.click(within(card('Secondary')).getByRole('button', { name: 'Delete' }));
    expect(requests.filter((request) => request.method === 'DELETE')).toHaveLength(0);
    const dialog = await screen.findByRole('dialog'); fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('two-model')).not.toBeInTheDocument());
    expect(screen.getByText('Secondary：Configuration deleted')).toBeVisible();
  });
  it('aborts a pending test when settings unmount and ignores the late result', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((complete) => { resolve = complete; })));
    const rendered = view(); fireEvent.click(within(card('Primary')).getByRole('button', { name: 'Test connection' }));
    const signal = vi.mocked(fetch).mock.calls[0]?.[1]?.signal;
    expect(screen.getByText('Testing…')).toBeVisible(); rendered.unmount(); expect(signal?.aborted).toBe(true);
    await act(async () => { resolve(new Response(JSON.stringify({ status: 'passed' }))); });
  });
});

it('explains an authentication test failure and retains the saved model', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'failed', code: 'API_AUTH_FAILED',
    testedAt: '2026-09-20T01:00:00Z', latencyMs: 24 }))));
  view(); fireEvent.click(within(card('Primary')).getByRole('button', { name: 'Test connection' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Authentication was rejected');
  expect(screen.getByText('Connection failed')).toBeVisible();
  expect(screen.getByText('one-model')).toBeVisible();
});


it('does not claim a new blank model is saved', () => {
  render(<I18nProvider initial="en"><ApiProfileManager initialConfig={{}} /></I18nProvider>);
  expect(screen.getByText('Not saved yet')).toBeVisible();
  expect(screen.queryByText('Model saved', { exact: true })).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

it('refreshes saved cards after changes in another window without sending a model test', async () => {
  view(); data = { ...data, activeProfileId: 'second', profiles: data.profiles.filter((profile) => profile.id === 'second') };
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(screen.queryByText('one-model')).not.toBeInTheDocument());
  expect(screen.getByText('two-model')).toBeVisible();
  expect(requests).toEqual([{ method: 'GET', path: '/api/map-design/api-profiles', body: {} }]);
});

it('does not overwrite unsaved edits on window focus', async () => {
  view(); fireEvent.click(within(card('Primary')).getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('API model'), { target: { value: 'unsaved-model' } });
  fireEvent(window, new Event('focus'));
  expect(screen.getByLabelText('API model')).toHaveValue('unsaved-model');
  expect(requests).toHaveLength(0);
});

it('does not display a saved-key badge for a keyless configuration', () => {
  render(<I18nProvider initial="en"><ApiProfileManager initialConfig={{ byokProviders: {
    default: { protocol: 'openai', apiKey: '', requiresApiKey: false, model: 'local-model' },
  } }} /></I18nProvider>);
  expect(screen.getByText('No API key stored')).toBeVisible();
  expect(screen.queryByText('Key saved; leave blank to keep it.')).not.toBeInTheDocument();
});
