import { Field, FieldLabel, FieldSet, FieldLegend, Input } from '@mapseekai/components';
import { MAP_API_EXECUTION_BOUNDS, type MapDesignApiExecutionSettings, resolveMapApiExecutionSettings } from '@mapseekai/contracts';
import { useI18n } from '../../i18n';
import { apiExecutionCopy } from '../../i18n/locales/api-execution';

export function ApiExecutionFields({ value, onChange, disabled }: {
  value: MapDesignApiExecutionSettings;
  onChange(value: MapDesignApiExecutionSettings): void;
  disabled: boolean;
}) {
  const { locale } = useI18n(); const copy = apiExecutionCopy[locale];
  let valid = true;
  try { resolveMapApiExecutionSettings(value); } catch { valid = false; }
  return <FieldSet disabled={disabled}>
    <FieldLegend>{copy.title}</FieldLegend><p>{copy.hint} {copy.automatic}.</p>
    {(Object.keys(MAP_API_EXECUTION_BOUNDS) as Array<keyof typeof MAP_API_EXECUTION_BOUNDS>).map((name) => {
      const [min, max] = MAP_API_EXECUTION_BOUNDS[name];
      return <Field key={name}><FieldLabel htmlFor={`api-budget-${name}`}>{copy[name]} ({min}–{max})</FieldLabel>
        <Input id={`api-budget-${name}`} type="number" min={min} max={max} step={1} value={value[name] ?? ''} placeholder={copy.automatic}
          onChange={(event) => {
            const next = { ...value };
            if (event.target.value === '') delete next[name];
            else next[name] = Number(event.target.value);
            onChange(next);
          }} />
      </Field>;
    })}
    {!valid ? <p role="alert">{copy.invalid}</p> : null}
  </FieldSet>;
}
