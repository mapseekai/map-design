import { useState } from 'react';

const STORAGE_PREFIX = 'map-design:workspace:v1';
const CHAT_WIDTH = { min: 320, max: 520, initial: 380 };
const INSPECTOR_WIDTH = { min: 280, max: 420, initial: 320 };

export interface MapDesignLayoutPreferences {
  chatWidth: number;
  chatCollapsed: boolean;
  inspectorWidth: number;
  inspectorPinned: boolean;
  setChatWidth(width: number): void;
  setChatCollapsed(collapsed: boolean): void;
  setInspectorWidth(width: number): void;
  setInspectorPinned(pinned: boolean): void;
}

interface StoredPreferences {
  chatWidth: number;
  chatCollapsed: boolean;
  inspectorWidth: number;
  inspectorPinned: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const stored = window.localStorage.getItem(`${STORAGE_PREFIX}:${key}`);
    if (stored === null) return fallback;
    const value = Number(stored);
    return Number.isFinite(value) ? clamp(value, min, max) : fallback;
  } catch {
    return fallback;
  }
}

function readBoolean(key: string): boolean {
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}:${key}`) === 'true';
  } catch {
    return false;
  }
}

function readPreferences(): StoredPreferences {
  return {
    chatWidth: readNumber('chat-width', CHAT_WIDTH.initial, CHAT_WIDTH.min, CHAT_WIDTH.max),
    chatCollapsed: readBoolean('chat-collapsed'),
    inspectorWidth: readNumber('inspector-width', INSPECTOR_WIDTH.initial, INSPECTOR_WIDTH.min, INSPECTOR_WIDTH.max),
    inspectorPinned: readBoolean('inspector-pinned'),
  };
}

function writePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}:${key}`, value);
  } catch {
    // A blocked storage implementation must not prevent workspace use.
  }
}

export function useMapDesignLayoutPreferences(): MapDesignLayoutPreferences {
  const [preferences, setPreferences] = useState<StoredPreferences>(readPreferences);

  const setChatWidth = (width: number) => {
    const next = clamp(width, CHAT_WIDTH.min, CHAT_WIDTH.max);
    setPreferences((current) => ({ ...current, chatWidth: next }));
    writePreference('chat-width', String(next));
  };
  const setChatCollapsed = (chatCollapsed: boolean) => {
    setPreferences((current) => ({ ...current, chatCollapsed }));
    writePreference('chat-collapsed', String(chatCollapsed));
  };
  const setInspectorWidth = (width: number) => {
    const next = clamp(width, INSPECTOR_WIDTH.min, INSPECTOR_WIDTH.max);
    setPreferences((current) => ({ ...current, inspectorWidth: next }));
    writePreference('inspector-width', String(next));
  };
  const setInspectorPinned = (inspectorPinned: boolean) => {
    setPreferences((current) => ({ ...current, inspectorPinned }));
    writePreference('inspector-pinned', String(inspectorPinned));
  };

  return { ...preferences, setChatWidth, setChatCollapsed, setInspectorWidth, setInspectorPinned };
}
