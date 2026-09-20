import {randomUUID} from 'node:crypto';
import {rename, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, resolve} from 'node:path';

export interface AtomicWriteDependencies {
  writeTemporary(path: string, contents: string): Promise<void>;
  rename(temporary: string, destination: string): Promise<void>;
  removeTemporary(path: string): Promise<void>;
  randomId(): string;
}

const defaultDependencies: AtomicWriteDependencies = {
  writeTemporary: (path, contents) =>
    writeFile(path, contents, {encoding: 'utf8', flag: 'wx', mode: 0o600}),
  rename,
  removeTemporary: (path) => rm(path, {force: true}),
  randomId: randomUUID,
};

/** Writes complete bytes to a sibling temporary file before one atomic rename. */
export async function atomicWrite(
  path: string,
  contents: string,
  overrides: Partial<AtomicWriteDependencies> = {},
): Promise<void> {
  const dependencies = {...defaultDependencies, ...overrides};
  const destination = resolve(path);
  const temporary = resolve(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${dependencies.randomId()}.tmp`,
  );
  try {
    await dependencies.writeTemporary(temporary, contents);
    await dependencies.rename(temporary, destination);
  } catch (error) {
    await dependencies.removeTemporary(temporary).catch(() => undefined);
    throw error;
  }
}
