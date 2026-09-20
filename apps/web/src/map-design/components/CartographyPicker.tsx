import { useEffect, useId, useState } from 'react';
import { Alert, AlertDescription, Button, Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem, Field, FieldLabel, FieldDescription } from '@mapseekai/components';
import { type CartographySummary } from '@mapseekai/map-design-contracts';
import { navigate } from '../../router';
import { useI18n } from '../../i18n';
import { cartographyCopy } from '../../i18n/locales/cartography';
import { listCartographies } from '../client';

export function CartographyPicker({ value, onChange, disabled = false }: {
  value: string; onChange(id: string): void; disabled?: boolean;
}) {
  const { locale } = useI18n();
  const selectId = useId();
  const copy = cartographyCopy[locale];
  const [documents, setDocuments] = useState<CartographySummary[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    const request = new AbortController();
    void listCartographies(request.signal).then((result) => {
      if (!request.signal.aborted) setDocuments((current) => [
        ...result.documents.filter((item) => !current.some((saved) => saved.id === item.id)), ...current,
      ]);
    })
      .catch(() => { if (!request.signal.aborted) setError(true); });
    return () => { request.abort(); };
  }, []);

  const selected = documents.find((document) => document.id === value);
  return <Field>
      <FieldLabel htmlFor={selectId}>{copy.label}</FieldLabel>
      <div className="flex min-w-0 items-center gap-3">
      <Select items={[{ value: "__none__", label: copy.none }, ...documents.map((document) => ({ value: document.id, label: document.name }))]} value={(value) || '__none__'} disabled={disabled} onValueChange={(selectedValue) => onChange((selectedValue === '__none__' ? '' : selectedValue ?? ''))}><SelectTrigger id={selectId}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>
        <SelectItem data-value="__none__" value="__none__">{copy.none}</SelectItem>
        {documents.map((document) => <SelectItem key={document.id} data-value={document.id} value={document.id}>{document.name}</SelectItem>)}
      </SelectGroup></SelectContent></Select>
      <Button type="button" variant="outline" disabled={disabled} onClick={() => navigate({ kind: 'cartographies' })}>{copy.manage}</Button>
      </div>
    {selected?.description ? <FieldDescription>{selected.description}</FieldDescription> : null}
    {error ? <Alert variant="destructive"><AlertDescription>{copy.error}</AlertDescription></Alert> : null}
  </Field>;
}
